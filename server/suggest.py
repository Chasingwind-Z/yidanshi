"""每日荐：AI 出建议，规则版保底。

daily() 对外签名与返回结构不变（app.py 零改动）：优先走 AI 通道（llm.ask + 当日
进程内缓存），从食单和近来吃饭的实情里挑菜、写朱批口吻理由；AI 不可用/异常/超时/
输出不合法/校验不过，一律静默落回规则版 _rules_daily()——永不因 AI 挂而 500。
返回加 "source" 字段（"ai"/"rules"）标记来源。

规则版 _rules_daily（不调 AI，零成本零延迟）：
从用户自己的食单里挑 1-2 道「今天适合做」的菜，配一句有依据的朱批口吻理由。
六路信号加权求和排名；理由只说得分最高的那一条信号，绝不罗列。

权重设计（数值只求相对大小，按「成长档案」的价值观排序）：
  W_NEVER   3.0   记了还没做过——档案最该补的一页
  W_STALE   2.5   ≥7 天没做——别让拿手菜生疏
  W_PROTEIN 2.5   最近 3 餐蛋白都偏低 × 这道是高蛋白菜——营养短板优先补
  W_CAT     2.0   分类多样性——这个分类最近 5 餐没出现过
  W_KCAL    2.0   设了每日热量目标且今天已记餐——每餐热量落在今日余量内
  W_PANTRY  1.5   冰箱（pantry）食材命中 ≥2 样——顺手清库存
  W_QUICK   1.0   工作日轻推 ≤30 分钟的省事菜——只是顺水推舟，不当主理由

确定性：同一天多次请求结果一致——tiebreak 用「日期字符串+菜 id」做随机种子，
刷新不跳变，第二天种子变了才换一批。
"""
from __future__ import annotations

import json
import random
import re
import threading
import time
from datetime import date, timedelta

from . import llm, nutrition, storage

MIN_RECIPES = 3       # 食单太小（<3 道）不荐：翻来覆去就那几道，荐了显得聒噪
STALE_DAYS = 7        # 超过这个天数没做算「有阵子没做了」
RECENT_CATS = 5       # 多样性看最近几餐的分类
LOW_PROTEIN_G = 15    # 每餐蛋白低于此值（g）算偏低
HIGH_PROTEIN_G = 20   # 每餐蛋白高于此值（g）算高蛋白菜
KCAL_MIN_ROOM = 150   # 今日热量余量少于此值就别荐了（硬塞不健康）
MIN_SCORE = 1.5       # 总分低于此值不进候选：孤零零一条「省事」不构成推荐理由

W_NEVER, W_STALE, W_PROTEIN, W_CAT, W_KCAL, W_PANTRY, W_QUICK = 3.0, 2.5, 2.5, 2.0, 2.0, 1.5, 1.0

AI_TIMEOUT = 60        # openai 兼容通道超时（秒）；CLI 通道固定 180s，见 llm.ask
AI_FAIL_COOLDOWN = 600 # 秒：AI 刚挂过就先歇会。CLI 通道失败可拖满 180s，加锁后请求会
                       # 一个个排队撞墙；冷却期内直接走规则版，最多一个请求承担慢失败
AI_REASON_MAX = 40     # AI 理由硬截断长度（prompt 要求 ≤22 字，超了砍不废）
FACTS_PANTRY_MAX = 20  # 喂给 AI 的 pantry 条数上限
FACTS_RECIPES_MAX = 40 # 喂给 AI 的菜谱条数上限

# 多样性理由按分类说人话；不在表里的自定义分类走兜底句式
_CAT_REASON = {
    "羹汤": "这几天没喝汤了，来一碗",
    "饭粥": "这几天没吃饭粥了",
    "面点": "有些日子没吃面点了",
    "小炒": "这几天没炒个菜了",
    "甜点": "好些天没来点甜的了",
}


def _safe_date(s) -> date | None:
    try:
        return date.fromisoformat(str(s))
    except ValueError:
        return None


def _protein_per_serving(r: dict) -> float | None:
    """每餐蛋白（g）：用 nutrition.compute 的整锅实算 ÷ servings——
    与 per_serving_kcal 同口径，不另起炉灶重算。算不出（没克重/查无数据）返回 None。"""
    c = nutrition.compute(r.get("ingredients", []))
    if not c:
        return None
    return c["protein_g"] / max(1, r.get("servings") or 1)


def _rules_daily(day: str | None = None) -> dict:
    today = _safe_date(day) or date.today()
    day = today.isoformat()
    recipes = storage.list_recipes()
    if len(recipes) < MIN_RECIPES:
        return {"suggestions": [], "date": day}

    # 食历按（日期, id）倒序——与 /api/meals 同口径；日期强转字符串防脏数据崩排序
    meals = sorted(storage.list_meals(),
                   key=lambda m: (str(m.get("date", "")), str(m.get("id", ""))), reverse=True)
    by_id = {r["id"]: r for r in recipes}

    # 每道菜最近一次做的日期（未来日期的脏记录也照收：算出来 days<0 自然不触发间隔信号）
    last_made: dict[str, date] = {}
    for m in meals:
        d = _safe_date(m.get("date"))
        rid = m.get("recipe_id")
        if d and rid and (rid not in last_made or d > last_made[rid]):
            last_made[rid] = d

    # 多样性：最近 5 餐出现过的分类（菜谱已删的餐查不到分类，跳过）。
    # 餐数太少（<3 餐有分类）不启用——不然人人「没出现过」，信号成了噪声
    recent_cats: set[str] = set()
    n_cat = 0
    for m in meals[:RECENT_CATS]:
        r = by_id.get(m.get("recipe_id", ""))
        if r:
            recent_cats.add(r["category"])
            n_cat += 1
    diversity_on = n_cat >= 3

    # 蛋白：最近 3 餐、至少 2 餐算得出蛋白、且算得出的全都偏低才触发（宁缺毋滥）。
    # 餐记录没有蛋白快照，用当前菜谱近似——每餐口径见 _protein_per_serving
    protein_low = False
    if len(meals) >= 3:
        ps = []
        for m in meals[:3]:
            r = by_id.get(m.get("recipe_id", ""))  # 菜谱已删的餐算不了蛋白，跳过
            p = _protein_per_serving(r) if r else None
            if p is not None:
                ps.append(p)
        protein_low = len(ps) >= 2 and all(p < LOW_PROTEIN_G for p in ps)

    # 热量预算：设了 goal.kcal 且今天已记过餐才有「余量」可言
    try:
        goal_kcal = int(float((storage.read_doc("config") or {}).get("goal", {}).get("kcal")))
    except (TypeError, ValueError):
        goal_kcal = None
    kcal_room = None
    today_meals = [m for m in meals if str(m.get("date", "")) == day]
    if goal_kcal and today_meals:
        eaten = 0
        for m in today_meals:
            k = m.get("kcal")  # 快照优先，老记录回退现算——与 /api/meals 口径一致
            if k is None and m.get("recipe_id") in by_id:
                k = nutrition.per_serving_kcal(by_id[m["recipe_id"]])
            eaten += k or 0
        room = goal_kcal - eaten
        if room >= KCAL_MIN_ROOM:
            kcal_room = room

    pantry = (storage.read_doc("pantry") or {}).get("items", [])
    workday = today.weekday() < 5
    eaten_today = {m.get("recipe_id") for m in today_meals}

    scored: list[tuple[float, float, dict, str]] = []
    for r in recipes:
        if r["id"] in eaten_today:  # 今天已经吃过的不再荐
            continue
        signals: list[tuple[float, str]] = []  # (权重, 理由)；按理由优先级顺序 append，
        # 权重打平时 max() 取先出现的——间隔 > 蛋白 > 多样性 > 热量 > 冰箱 > 省事

        last = last_made.get(r["id"])
        if last is None:
            signals.append((W_NEVER, "记了还没做过，试试？"))
        elif (today - last).days >= STALE_DAYS:
            signals.append((W_STALE, f"有阵子没做{r['name']}了"))

        if protein_low and (_protein_per_serving(r) or 0) >= HIGH_PROTEIN_G:
            signals.append((W_PROTEIN, "最近蛋白吃得少，这道补一补"))

        if diversity_on and r["category"] not in recent_cats:
            signals.append((W_CAT, _CAT_REASON.get(r["category"], f"这几天没吃{r['category']}了")))

        if kcal_room is not None:
            k = nutrition.per_serving_kcal(r)
            if k is not None and k <= kcal_room:
                signals.append((W_KCAL, f"今天还有 ≈{round(kcal_room, -1)} kcal 余量，这道正合适"))

        hits = [i["name"] for i in r.get("ingredients", [])
                if any(it in i["name"] or i["name"] in it for it in pantry)]  # 同 /api/random 的匹配口径
        if len(hits) >= 2:
            signals.append((W_PANTRY, f"冰箱里的{hits[0]}、{hits[1]}正好用掉"))

        if workday and r.get("minutes") and r["minutes"] <= 30:
            signals.append((W_QUICK, f"{r['minutes']} 分钟就能好"))

        total = sum(w for w, _ in signals)
        if total < MIN_SCORE:
            continue
        reason = max(signals, key=lambda s: s[0])[1]
        tie = random.Random(f"{day}:{r['id']}").random()  # 同分时按日期种子洗牌，当天稳定
        scored.append((total, tie, r, reason))

    scored.sort(key=lambda t: (-t[0], t[1], t[2]["id"]))
    picks = scored[:1]
    if picks and len(scored) > 1:
        # 第二道尽量换个分类，两道一荤汤一小炒比两道同类更像会过日子的建议
        alt = next((s for s in scored[1:] if s[2]["category"] != picks[0][2]["category"]), scored[1])
        picks.append(alt)

    return {"suggestions": [{"recipe_id": r["id"], "name": r["name"], "reason": reason}
                            for _, _, r, reason in picks],
            "date": day}


# ---------- AI 路径 ----------

_AI_PROMPT = """你是「一箪食」私厨的老管家，念过些书，说话简省、有分寸，批注用朱批口吻。
下面是主人食单与近来吃饭的实情（JSON）。请从 recipes 里挑出今天最值得做的 1-2 道菜。

{facts_json}

规矩：
1. 只能选 recipes 里有的 id；today_eaten 出现过的菜不选。
2. 理由必须落在实情上（几天没做、某类菜久未出现、蛋白或热量、冰箱食材、快手省事），
   可结合日期的季节与节气常识（如伏天宜清淡）；不许编造实情里没有的数据。
3. 每道配一句理由，不超过 22 个字，朱批口吻。例：「三日未见青蔬，宜清炒时蔬」
   「大暑将至，一碗汤最是熨帖」「记了半月未做，今日一试」。
4. 若挑两道，尽量不同分类；实在没有合适的可只出一道。
5. 只输出 JSON，无其他文字：{"suggestions":[{"recipe_id":"...","reason":"..."}]}"""

# 当日缓存：进程内存单槽——键 =（日期, 今天已吃的 recipe_id 集合, 菜谱数），任一变了就重算，
# 只留最新一条。本地 launchd 常驻，缓存整天有效；云端容器缩零重启会丢缓存、当天重算一次——
# deepseek-v4-flash 一次调用成本可忽略，接受这个取舍，不落 storage（不动 kvdoc 命名）。
_ai_cache: dict = {}
_ai_lock = threading.Lock()
_ai_fail_at = 0.0  # 上次 AI 真调失败的时刻（time.monotonic），配合 AI_FAIL_COOLDOWN


def _build_facts(today: date, day: str, recipes: list[dict], meals: list[dict],
                 by_id: dict, today_meals: list[dict]) -> dict:
    """组喂给 AI 的 compact 事实 JSON。全部复用现有函数/口径，不另起炉灶重算。"""
    # 每道菜最近一次做的日期 + 做过次数（脏日期跳过，与规则版口径一致）
    last_made: dict[str, date] = {}
    times: dict[str, int] = {}
    for m in meals:
        rid = m.get("recipe_id")
        if not rid:
            continue
        times[rid] = times.get(rid, 0) + 1
        d = _safe_date(m.get("date"))
        if d and (rid not in last_made or d > last_made[rid]):
            last_made[rid] = d

    def meal_name(m: dict) -> str:
        r = by_id.get(m.get("recipe_id", ""))
        return m.get("recipe_name") or (r["name"] if r else "")

    def meal_kcal(m: dict):
        k = m.get("kcal")  # 快照优先，老记录回退现算——与 /api/meals 口径一致
        r = by_id.get(m.get("recipe_id", ""))
        if k is None and r:
            k = nutrition.per_serving_kcal(r)
        return k

    week_ago = today - timedelta(days=7)
    recent = [{"date": str(m.get("date", "")), "name": meal_name(m),
               "category": (by_id.get(m.get("recipe_id", "")) or {}).get("category"),
               "kcal": meal_kcal(m)}
              for m in meals
              if (d := _safe_date(m.get("date"))) and week_ago <= d <= today]

    try:
        goal_kcal = int(float((storage.read_doc("config") or {}).get("goal", {}).get("kcal")))
    except (TypeError, ValueError):
        goal_kcal = None

    rows = []
    for r in recipes[:FACTS_RECIPES_MAX]:
        p = _protein_per_serving(r)
        last = last_made.get(r["id"])
        rows.append({"id": r["id"], "name": r["name"], "category": r["category"],
                     "minutes": r.get("minutes"),
                     "kcal_per_serving": nutrition.per_serving_kcal(r),
                     "protein_per_serving": round(p, 1) if p is not None else None,
                     "times": times.get(r["id"], 0),
                     "days_since_last": (today - last).days if last is not None else None,
                     "main_ingredients": [i.get("name", "") for i in r.get("ingredients", [])[:4]]})

    return {"date": day,
            "weekday": "星期" + "一二三四五六日"[today.weekday()],
            "goal_kcal": goal_kcal,
            "pantry": ((storage.read_doc("pantry") or {}).get("items", []))[:FACTS_PANTRY_MAX],
            "today_eaten": [{"id": m["recipe_id"], "name": meal_name(m)}
                            for m in today_meals if m.get("recipe_id")],
            "recent_meals": recent,
            "recipes": rows}


def _parse_ai(out: str, by_id: dict, eaten_today: frozenset, day: str) -> dict | None:
    """严格校验 AI 输出，任何不对付返回 None（回退规则版）。
    name 一律服务端按 recipe_id 回填，不信任模型输出的菜名。"""
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group())
    except (ValueError, TypeError):
        return None
    sugg = data.get("suggestions") if isinstance(data, dict) else None
    if not isinstance(sugg, list) or not 1 <= len(sugg) <= 2:
        return None
    picks, seen = [], set()
    for s in sugg:
        rid = s.get("recipe_id") if isinstance(s, dict) else None
        reason = str(s.get("reason") or "").strip() if isinstance(s, dict) else ""
        if rid not in by_id or rid in eaten_today or rid in seen or not reason:
            return None
        seen.add(rid)
        picks.append({"recipe_id": rid, "name": by_id[rid]["name"],
                      "reason": reason[:AI_REASON_MAX]})
    return {"suggestions": picks, "date": day, "source": "ai"}


def _ai_daily(day: str | None) -> dict | None:
    """AI 路径：通道可用才组事实真调。返回 None 表示这条路走不通，由 daily() 落回规则版。"""
    if not llm.backend_status()["available"]:
        return None
    today = _safe_date(day) or date.today()
    day = today.isoformat()
    recipes = storage.list_recipes()
    if len(recipes) < MIN_RECIPES:
        return None  # 食单太小不荐——与规则版同一门槛，由规则版统一返回空 suggestions
    meals = sorted(storage.list_meals(),
                   key=lambda m: (str(m.get("date", "")), str(m.get("id", ""))), reverse=True)
    by_id = {r["id"]: r for r in recipes}
    today_meals = [m for m in meals if str(m.get("date", "")) == day]
    eaten_today = frozenset(m.get("recipe_id") for m in today_meals if m.get("recipe_id"))

    key = (day, eaten_today, len(recipes))
    global _ai_fail_at
    with _ai_lock:  # 锁住整段：并发请求第二个等第一个算完直接吃缓存，不双算
        if _ai_cache.get("key") == key:
            return _ai_cache["value"]
        if time.monotonic() - _ai_fail_at < AI_FAIL_COOLDOWN:
            return None  # 刚挂过，冷却期内不再撞，直接规则版
        try:
            facts = _build_facts(today, day, recipes, meals, by_id, today_meals)
            out = llm.ask(_AI_PROMPT.replace("{facts_json}",
                                             json.dumps(facts, ensure_ascii=False, separators=(",", ":"))),
                          timeout=AI_TIMEOUT, json_mode=True)
            result = _parse_ai(out, by_id, eaten_today, day)
        except Exception:
            result = None
        if result is None:
            _ai_fail_at = time.monotonic()
            return None
        _ai_cache["key"], _ai_cache["value"] = key, result
        return result


def daily(day: str | None = None) -> dict:
    """每日荐入口：AI 出建议，规则版保底。签名与返回结构不变（app.py 零改动）。

    AI 任何一步失败（不可用/异常/超时/JSON 不合法/校验不过）都静默落回规则版——
    永不因 AI 挂而 500。source 字段标记来源："ai" / "rules"。"""
    # 进度钩子：食单不满 MIN_RECIPES 时不是沉默的空，而是告诉前端还差几道
    #（「再记 N 道菜，管家就开始替你参谋」）。锁定分支在最前，缓存/AI 路径全不碰。
    n = len(storage.list_recipes())
    if n < MIN_RECIPES:
        today = _safe_date(day) or date.today()
        return {"suggestions": [], "locked": {"need": MIN_RECIPES - n},
                "date": today.isoformat(), "source": "rules"}
    try:
        result = _ai_daily(day)
        if result is not None:
            return result
    except Exception:
        pass  # AI 挂了不声张，规则版兜底
    result = _rules_daily(day)
    result["source"] = "rules"
    return result
