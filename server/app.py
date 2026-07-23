"""一箪食 · 后端。启动：scripts/dev.sh 或 .venv/bin/uvicorn server.app:app --port 18100"""
from __future__ import annotations

import hmac
import math
import os
import random
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import cutout, imagegen, llm, nutrition, photostore, segfood, storage, suggest

app = FastAPI(title="一箪食 yidanshi")
storage.init_dirs()

# API 密钥从 data/secrets.env 加载（launchd 环境读不到 shell 变量；data/ 不进 git）
_SECRETS_FILE = storage.DATA / "secrets.env"


def _load_secrets() -> None:
    if _SECRETS_FILE.exists():
        for line in _SECRETS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


_load_secrets()


# ---------- 主人令牌（可选，默认关）----------
# 局域网自用默认不设防（手机打开即用）。要把服务暴露到公网（内网穿透/端口转发）时，
# 在 data/secrets.env 里设 YIDANSHI_TOKEN=一串随机字符，即可给「主人接口」加一道口令：
# 访客点菜链接（/api/guest/*）另有 guest token，不受影响；静态资源/封面图照常公开。
# 云托管另有 openid 鉴权：设 YIDANSHI_OWNER_OPENID 后，callContainer 注入的
# X-WX-OPENID 等于它 → 视同主人；不等 → 仅放行 _PUBLIC_API。两道门任一通过即主人。
OWNER_TOKEN = os.environ.get("YIDANSHI_TOKEN", "").strip()
OWNER_OPENID = os.environ.get("YIDANSHI_OWNER_OPENID", "").strip()
_PUBLIC_API = {"/api/guest/menu", "/api/guest/order", "/api/guest/order-status",
               "/api/whoami"}  # 开令牌后仍对访客开放的接口


@app.middleware("http")
async def owner_gate(request: Request, call_next):
    if (OWNER_TOKEN or OWNER_OPENID) and request.method != "OPTIONS":  # 放行 CORS 预检
        p = request.url.path
        if p.startswith("/api/") and p not in _PUBLIC_API:
            ok = False
            # 晒图接口（纸上食单/教程卡/月结卡）是「图」：小程序/浏览器 <Image> 的镜像请求
            # 带不上 openid/token 头，放一条 guest token 的 query 通道（?t=…）。t 校验不过
            # 或没带仍走下面的主人鉴权——不是无条件公开，陌生人白嫖不了。
            if p == "/api/menuposter" or p.startswith(("/api/recipecard/", "/api/monthcard/")):
                t = request.query_params.get("t", "")
                if t:
                    try:
                        gt = _guest_token()  # 定义在本函数之后；请求时才查全局名，无顺序问题
                    except Exception:  # noqa: BLE001 —— 存储抖动别把鉴权打成 500，回落主人鉴权
                        gt = ""
                    ok = bool(gt) and hmac.compare_digest(t.encode("utf-8"), gt.encode("utf-8"))
            if not ok and OWNER_TOKEN:  # 原有口令逻辑原样保留
                supplied = (request.headers.get("x-token")
                            or request.cookies.get("yidanshi_token")
                            or request.query_params.get("token", ""))
                # 转 bytes 再比较：compare_digest 对含非 ASCII 的 str 会抛 TypeError → 500，转 bytes 稳（仍是定时安全比较）
                ok = hmac.compare_digest(supplied.encode("utf-8"), OWNER_TOKEN.encode("utf-8"))
            if not ok and OWNER_OPENID:
                openid = request.headers.get("x-wx-openid", "")
                ok = bool(openid) and hmac.compare_digest(openid.encode("utf-8"),
                                                          OWNER_OPENID.encode("utf-8"))
            if not ok:
                return JSONResponse({"detail": "需要主人令牌"}, status_code=401)
    return await call_next(request)


# CORS 必须在 owner_gate **之后**注册，才能成为最外层中间件（Starlette 后注册者在外）——
# 否则 owner_gate 短路返回的 401 拿不到 CORS 头，浏览器把「需要主人令牌」当成不明网络错。
# 只放行本机来源的浏览器页面读取响应；不改变「谁能调接口」，小程序 callContainer 不受此限。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"], allow_headers=["*"], allow_credentials=True,
)


@app.get("/api/whoami")
def whoami(request: Request):
    """回显 callContainer 注入的 openid（任何人可调）：zzf 首次部署后用它拿自己的 openid
    填进 YIDANSHI_OWNER_OPENID。"""
    return {"openid": request.headers.get("x-wx-openid") or None}


# ---------- 设置 ----------

def _font_health() -> dict:
    """渲染字体自诊断：自带字体文件在不在 + _font 实际解析到哪个字体（名字）。"""
    try:
        from . import monthcard
        f = monthcard._font(20, index=6)
        try:
            name = "/".join(f.getname())
        except Exception:  # noqa: BLE001
            name = type(f).__name__
        return {"bundled_exists": Path(monthcard._BUNDLED).exists(),
                "bundled_path": monthcard._BUNDLED, "resolved": name}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {str(e)[:150]}"}


def _config_payload() -> dict:
    # 存储挂了也要能开口——否则 DB 一断 /api/config 先 500，自诊断字段反而看不到。
    # 每个碰数据库的调用都单独兜住（backend_status 内部也读 config，同样会因 DB 断而抛）。
    try:
        cfg = storage.read_doc("config") or {}
    except Exception:  # noqa: BLE001
        cfg = {}
    try:
        status = {**llm.backend_status(), "imagegen": imagegen.backend_status()}
    except Exception:  # noqa: BLE001
        status = {}
    envs = {c.get("api_key_env") for c in (cfg.get("llm", {}), cfg.get("imagegen", {})) if c.get("api_key_env")}
    return {"llm": cfg.get("llm", {}), "imagegen": cfg.get("imagegen", {}), "goal": cfg.get("goal", {}),
            "status": status,
            "owner_token": bool(OWNER_TOKEN),
            "storage": storage.health(),  # 云上排障：存储模式 + 数据库连通性（主人可见）
            "font": _font_health(),  # 云上排障：自带字体是否进镜像/实际解析到谁（豆腐块事故用）
            "secrets": {e: bool(os.environ.get(e)) for e in envs}}


@app.get("/api/config")
def get_config():
    return _config_payload()


@app.put("/api/config")
def put_config(body: dict):
    # 读现有配置为基底，只覆盖 body 里出现的段，保留 guest 等未提及的顶层字段
    # （历史 bug：整体重建会静默吞掉 guest token，作废分享链接）
    cfg = storage.read_doc("config") or {}
    for section in ("llm", "imagegen", "goal"):
        if section not in body:
            continue
        clean = {k: v for k, v in (body.get(section) or {}).items() if v not in ("", None)}
        if clean:
            cfg[section] = clean
        else:
            cfg.pop(section, None)  # 传空段 = 清除（如清空每日目标）
    storage.write_doc("config", cfg)

    secrets = {k: v.strip() for k, v in (body.get("secrets") or {}).items() if v and v.strip()}
    if secrets:
        lines = _SECRETS_FILE.read_text(encoding="utf-8").splitlines() if _SECRETS_FILE.exists() else []
        kept = [ln for ln in lines if not any(ln.strip().startswith(f"{k}=") for k in secrets)]
        kept += [f"{k}={v}" for k, v in secrets.items()]
        _SECRETS_FILE.write_text("\n".join(kept) + "\n", encoding="utf-8")
        os.environ.update(secrets)
    return _config_payload()


_BACKUP_DIR = storage.DATA / "backups"


def _backup_list() -> list[dict]:
    if not _BACKUP_DIR.exists():
        return []
    return [{"name": p.name, "size_mb": round(p.stat().st_size / 1048576, 1),
             "time": datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")}
            for p in sorted(_BACKUP_DIR.glob("yidanshi-*.zip"), reverse=True)]


@app.get("/api/backup")
def list_backups():
    return {"backups": _backup_list()}


@app.post("/api/backup")
def make_backup():
    """全量备份 data/ 到 data/backups/*.zip，保留最近 5 份；密钥文件不入包。"""
    import zipfile
    _BACKUP_DIR.mkdir(exist_ok=True)
    path = _BACKUP_DIR / f"yidanshi-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in storage.DATA.rglob("*"):
            if p.is_file() and _BACKUP_DIR not in p.parents and p.name != "secrets.env":
                z.write(p, p.relative_to(storage.DATA))
    # 按修改时间排（不按文件名）：手工放进来的 yidanshi-手动备份.zip 会排到日期名之后，
    # 被当成「最新」反而挤掉一份真正最新的
    for old in sorted(_BACKUP_DIR.glob("yidanshi-*.zip"), key=lambda p: p.stat().st_mtime)[:-5]:
        old.unlink()
    return {"backups": _backup_list()}


# ---------- 菜谱 ----------

# 示例菜判定：id 在 examples 集合 **且内容仍与示例出厂版一致** 才算 demo。
# 只按 id 判定的教训：zzf 自己的 7 道真菜正是 examples 的来源（id 完全重合），
# 纯 id 判定会把主人的菜全标成「示例」，「收走示例菜」还会误删没记过餐的真菜。
# 内容一致性用签名字段比对（name/category/ingredients/steps/tips）——
# 摆进来的示例只要被用户改过一笔（实测回填/改做法），就自动"转正"为用户的菜。
_DEMO_SIGS: dict[str, tuple] = {}
for _p in (storage.ROOT / "examples" / "recipes").glob("*.md"):
    try:
        _er = storage._parse_md(_p.read_text(encoding="utf-8"))
        _DEMO_SIGS[_p.stem] = (_er.get("name"), _er.get("category"), _er.get("cover"),
                               [(i.get("name"), i.get("amount")) for i in _er.get("ingredients", [])],
                               _er.get("steps"), _er.get("tips"))
    except Exception:  # noqa: BLE001 —— 单个示例文件坏了别把服务拖死
        continue


def _is_demo(r: dict) -> bool:
    sig = _DEMO_SIGS.get(r["id"])
    # cover 也进签名："拍了自己的照片，这就是你的菜了"——zzf 的 7 道真菜与示例
    # 唯一的差异恰是封面（示例是出厂封面），纯文字签名会把主人的菜误标成示例
    return sig is not None and sig == (r.get("name"), r.get("category"), r.get("cover"),
                                       [(i.get("name"), i.get("amount")) for i in r.get("ingredients", [])],
                                       r.get("steps"), r.get("tips"))


@app.get("/api/recipes")
def recipes():
    stats = storage.recipe_stats()
    out = []
    for r in storage.list_recipes():
        s = stats.get(r["id"], {})
        whole, src = nutrition.effective(r)
        out.append({**r, "times": s.get("times", 0), "rating": s.get("rating"),
                    "kcal_effective": nutrition.per_serving_kcal(r), "kcal_whole": whole, "kcal_source": src,
                    "demo": _is_demo(r)})
    return {"categories": storage.DEFAULT_CATEGORIES, "recipes": out}


@app.get("/api/recipes/{rid}")
def recipe(rid: str):
    r = storage.get_recipe(rid)
    if r is None:
        raise HTTPException(404, "no such recipe")
    s = storage.recipe_stats().get(rid, {})
    # 朱批：这道菜历次记录的备注，红批注上教程卡
    notes = [{"date": m["date"], "note": m["note"]}
             for m in storage.list_meals() if m["recipe_id"] == rid and m.get("note")]
    whole, src = nutrition.effective(r)
    return {**r, "times": s.get("times", 0), "rating": s.get("rating"),
            "nutrition": nutrition.compute(r["ingredients"]),
            "kcal_effective": nutrition.per_serving_kcal(r), "kcal_whole": whole, "kcal_source": src,
            "annotations": sorted(notes, key=lambda n: n["date"], reverse=True)[:5]}


def _clean_recipe(r: dict) -> dict:
    """把菜谱字段规整成落库前的合法形状：类型不对的直接 400，别一路裸奔到 500。
    （第3轮 agent 实测：ingredients=null / "字符串" / 食材缺 name / servings={} 全是 500）"""
    out = dict(r)

    def _list(key):
        v = out.get(key)
        if v is None:
            return []
        if not isinstance(v, list):
            raise HTTPException(400, f"{key} 应该是数组")
        return v

    ings = []
    for i in _list("ingredients"):
        if not isinstance(i, dict) or not str(i.get("name", "")).strip():
            raise HTTPException(400, "每个食材都要有名字")
        ings.append({"name": str(i["name"]).strip(), "amount": str(i.get("amount", "")).strip(),
                     "grams": storage.coerce_grams(i.get("grams"))})
    out["ingredients"] = ings
    out["steps"] = [str(s).strip() for s in _list("steps") if str(s).strip()]
    out["tips"] = [str(t).strip() for t in _list("tips") if str(t).strip()]

    def _int(key, lo, hi, default=None):
        v = out.get(key)
        if v is None or v == "":
            return default
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise HTTPException(400, f"{key} 应该是数字")
        try:
            f = float(v)
            if not math.isfinite(f):  # 1e400 → inf，int(inf) 抛 OverflowError 会裸奔成 500
                raise ValueError
            n = int(f)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(400, f"{key} 应该是数字")
        return max(lo, min(hi, n))

    out["servings"] = _int("servings", 1, 99, 1) or 1   # 上界防 999999999 把每餐热量摊成 0
    out["kcal"] = _int("kcal", 0, 100_000)
    out["minutes"] = _int("minutes", 0, 10_000)
    return out


@app.post("/api/recipes")
def create_recipe(body: dict):
    if not str(body.get("name", "")).strip():
        raise HTTPException(400, "菜名不能为空")
    body.pop("id", None)  # 建菜一律按菜名生成新 slug，忽略客户端传入 id（防覆盖/越目录写）
    r = storage.save_recipe(_clean_recipe(body))
    return storage.get_recipe(r["id"]) or r


@app.put("/api/recipes/{rid}")
def update_recipe(rid: str, body: dict):
    old = storage.get_recipe(rid)
    if old is None:
        raise HTTPException(404, "菜谱不存在")
    if not storage._ID_RE.fullmatch(rid):
        raise HTTPException(400, "非法菜谱 id")
    # 以旧菜谱为基底合并：body 里没带的字段沿用旧值，避免部分更新静默清空
    #（尤其 created 不被重置为今天；AI 走 API 做局部编辑很常见）
    merged = {**{k: old.get(k) for k in
                 ("name", "category", "cover", "source", "created", "kcal", "minutes",
                  "difficulty", "servings", "ingredients", "steps", "tips")},
              **body}  # body 带的字段覆盖（含显式清空为 null）；没带的沿用旧值
    merged["id"] = rid
    try:
        storage.save_recipe(_clean_recipe(merged))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return storage.get_recipe(rid)  # 回落库后重新解析的结果，别回内存里的 merged（口径才一致）


def _pantry() -> list[str]:
    return (storage.read_doc("pantry") or {}).get("items", [])


@app.get("/api/pantry")
def get_pantry():
    return {"items": _pantry()}


@app.put("/api/pantry")
def put_pantry(body: dict):
    seen, items = set(), []
    for it in body.get("items", []):
        it = str(it).strip()
        if it and it not in seen:
            seen.add(it)
            items.append(it)
    storage.write_doc("pantry", {"items": items})
    return {"items": items}


@app.get("/api/random")
def random_pick(category: str | None = None, avoid_days: int = 0, max_minutes: int = 0,
                difficulty: str = "", use_pantry: int = 0, exclude: str = ""):
    """翻牌子：avoid_days=N 排除最近 N 天做过的；max_minutes=M 只要 M 分钟内能做的；
    difficulty=简单 只要省事的；use_pantry=1 优先冰箱里有食材的菜。
    exclude=id1,id2 划掉重抽（用户明说不想吃的，硬排除不放宽）。
    条件内没菜时逐级放宽并带 relaxed 标记，绝不空手而归——唯 exclude 例外：
    全被划掉时如实说翻完了，别把人家刚划掉的又端回去。"""
    rs = [r for r in storage.list_recipes() if category in (None, "", r["category"])]
    if not rs:
        raise HTTPException(404, "菜单还是空的")
    skipped = {s.strip() for s in exclude.split(",") if s.strip()}
    if skipped:
        rs = [r for r in rs if r["id"] not in skipped]
        if not rs:
            raise HTTPException(404, "今天的牌都翻完啦")
    relaxed = False
    if avoid_days > 0:
        cutoff = (date.today() - timedelta(days=avoid_days)).isoformat()
        today = date.today().isoformat()
        # 同样要上界：一条误填成 2027 年的记录会让这道菜「永远算刚吃过」，再也翻不到牌
        recent = {m["recipe_id"] for m in storage.list_meals()
                  if cutoff <= str(m.get("date", "")) <= today}
        fresh = [r for r in rs if r["id"] not in recent]
        rs, relaxed = (fresh, relaxed) if fresh else (rs, True)
    if max_minutes > 0:
        quick = [r for r in rs if r.get("minutes") and r["minutes"] <= max_minutes]
        rs, relaxed = (quick, relaxed) if quick else (rs, True)
    if difficulty:
        easy = [r for r in rs if r.get("difficulty") == difficulty]
        rs, relaxed = (easy, relaxed) if easy else (rs, True)
    if use_pantry:
        pantry = _pantry()
        def score(r: dict) -> int:
            return sum(1 for ing in r["ingredients"]
                       if any(it in ing["name"] or ing["name"] in it for it in pantry))
        scored = [(score(r), r) for r in rs]
        best = max((s for s, _ in scored), default=0)
        if best > 0:
            rs = [r for s, r in scored if s == best]
        else:
            relaxed = True
    return {**random.choice(rs), "relaxed": relaxed}


@app.get("/api/suggest")
def daily_suggest():
    """每日荐：规则版（零成本零延迟），从自己的食单里挑今天适合做的 1-2 道。
    规则与权重见 server/suggest.py；主人接口（客人 401，前端静默不渲染）。"""
    return suggest.daily()


@app.post("/api/nutrition/preview")
def nutrition_preview(body: dict):
    """编辑器实时合计：传 ingredients 列表，返回 compute 结果（本地纯计算，零成本）。"""
    return nutrition.compute(body.get("ingredients", [])) or {}


@app.get("/api/ingredient-names")
def ingredient_names():
    """可选食材名列表（内置库 + 用户缓存），给编辑器 datalist 用。"""
    return {"names": nutrition.all_names(),
            "defaults": {k: v["default_g"] for k, v in nutrition.builtin().items() if v.get("default_g")}}


@app.get("/api/ingredient/{name}")
def ingredient_info(name: str):
    """食材小百科：内置营养库（成分表口径，标来源）优先；没有再走用户缓存/AI 兜底。"""
    name = name.strip()[:20]
    if not name or "/" in name or name.startswith("."):
        raise HTTPException(400, "食材名不合法")

    if nutrition.is_packaged(name):
        # 成品包装食品/预制正餐/零食：确定性拦截，不查库/缓存/AI，一律留白 + 免责，绝不装懂
        return {"name": name, "kcal_per_100g": None, "protein_g": None, "fat_g": None, "carb_g": None,
                "benefits": [], "tips": [nutrition.PACKAGED_DISCLAIMER], "source": "成品包装食品，不做估算"}

    hit = nutrition.lookup(name)
    cached = nutrition.cached(name)
    if hit:
        # 内置库管数值和来源；功效/贴士文案若有 AI 缓存则合并进来（来源分开标注）
        return {**hit, "benefits": (cached or {}).get("benefits", []), "tips": (cached or {}).get("tips", []),
                "text_source": "AI 生成" if cached else ""}
    if cached:
        return cached
    try:
        info = llm.ingredient_info(name)
        info["source"] = nutrition.AI_SOURCE
    except Exception as e:
        raise HTTPException(502, str(e))
    storage.write_doc(f"ingredients/{name}", info)
    return info


# ---------- 抠图 ----------

@app.post("/api/cutout")
async def do_cutout(photo: UploadFile = File(...), already_cut: bool = Form(False),
                    mode: str = Form("auto"), cx: float = Form(-1), cy: float = Form(-1), r: float = Form(-1)):
    """mode: plate=抠出食物摆插画盘 / auto=AI抠图直出 / circle=参考圆直裁 / both=全都出让用户选 /
    polish=AI 图生图精修原照片；cx/cy/r 为参考圆相对坐标。

    抠图降级链：本地 rembg（birefnet）→（配了阿里云凭证时）segfood 抠出主体走同样的
    摆盘合成 → 圆框直裁（响应加 note 说明）。云端镜像本就无 rembg，行为不变。"""
    raw = await photo.read()
    stamp = datetime.now().strftime("p%Y%m%d%H%M%S%f")
    ext = Path(photo.filename or "x.jpg").suffix or ".jpg"
    photostore.save("raw", f"{stamp}{ext}", raw)
    circle = (cx, cy, r) if r > 0 else None
    note = None

    if mode == "polish":
        src = cutout._crop_region(raw, *circle) if circle else raw
        try:
            card_png = imagegen.refine(src)
        except Exception as e:
            raise HTTPException(502, str(e))
        results = {"polish": (card_png, card_png)}
    elif already_cut or cutout.is_transparent(raw):
        img = cutout.process(raw, already_cut=True)
        from PIL import Image
        import io as _io
        plate = cutout._png(cutout.make_plate_card(Image.open(_io.BytesIO(img[0])).convert("RGBA")))
        results = {"plate": (img[0], plate), "auto": img}
    else:
        modes = ["plate", "auto", "circle"] if mode == "both" else [mode]
        want_ai = any(m in ("plate", "auto") for m in modes)
        results = {}
        # 第一级：本地 rembg（birefnet）。失败（模型下载失败/推理崩）别 500，往下降级
        if cutout._have_rembg():
            try:
                results = cutout.process_modes(raw, modes, circle)
            except Exception:  # noqa: BLE001
                results = {}
        # 第二级：本地没抠出主体（未装 rembg / 上面失败）→ segfood（配了阿里云凭证时）
        if want_ai and not any(m in ("plate", "auto") for m in results):
            focused = cutout._crop_region(raw, *circle) if circle else raw
            seg = segfood.cut(focused)  # 未配凭证/库缺/失败一律返回 None
            if seg is not None:
                results = cutout.process_modes(raw, modes, circle, precut=seg)
        # 第三级：全链都没抠出来 → 只出圆框直裁，note 说明
        if want_ai and not any(m in ("plate", "auto") for m in results):
            if not results:
                results = cutout.process_modes(raw, ["circle"], circle) if circle else {}
            note = ("本地抠图失败，仅圆框直裁" if cutout._have_rembg()
                    else "云端未配抠图，仅圆框直裁")
        elif not want_ai and not results:
            results = cutout.process_modes(raw, modes, circle)  # 只要 circle：不需要抠图通道

    out = []
    for m, (cut_png, card_png) in results.items():
        pid = f"{stamp}-{m}"
        photostore.save("cut", f"{pid}.png", cut_png)
        card_url = photostore.save("cards", f"{pid}.png", card_png)
        out.append({"mode": m, "photo_id": pid, "card": card_url})
    resp = {"results": out}
    if note:
        resp["note"] = note
    return resp


@app.post("/api/replate")
def replate(body: dict):
    """换餐具：用已存的抠图重新合成菜卡（本地零成本）。tableware ∈ plate/bowl/saucer。"""
    pid, tw = body.get("photo_id", ""), body.get("tableware", "plate")
    data = photostore.load("cut", f"{pid}.png") if pid else None
    if data is None:
        raise HTTPException(404, "没有这张抠图")
    import io as _io

    from PIL import Image

    card = cutout.make_plate_card(Image.open(_io.BytesIO(data)).convert("RGBA"), tw)
    url = photostore.save("cards", f"{pid}.png", cutout._png(card))
    return {"card": url, "tableware": tw}


# ---------- AI 通道 ----------

@app.get("/api/ai/status")
def ai_status():
    return {**llm.backend_status(), "imagegen": imagegen.backend_status()}


@app.post("/api/ai/illustrate")
def ai_illustrate(body: dict):
    """逐张生成插画：{recipe_id, kind: "ing"|"step", index(从1起)}。前端按张循环调用以显示进度。"""
    r = storage.get_recipe(body.get("recipe_id", ""))
    if r is None:
        raise HTTPException(404, "no such recipe")
    kind, index = body.get("kind"), int(body.get("index", 0))
    n = len(r["ingredients"]) if kind == "ing" else len(r["steps"])
    if kind not in ("ing", "step") or not 1 <= index <= n:
        raise HTTPException(400, "bad kind/index")
    try:
        return {"url": imagegen.illustrate(r, kind, index)}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.post("/api/ai/extract")
def ai_extract(body: dict):
    """text=教程原文；或 url=分享链接（抖音等，服务端尽力抓文案再整理）。"""
    text, source = body.get("text", "").strip(), body.get("source", "")
    if body.get("url"):
        source = body["url"]
        fetched = llm.fetch_link_text(body["url"])
        if len(fetched) < 15:
            raise HTTPException(422, "这个链接抓不到文案（平台反爬）——去 App 里长按复制它的文案粘过来吧")
        text = (fetched + "\n" + text).strip()
    if not text:
        raise HTTPException(400, "教程原文不能为空")
    try:
        return llm.extract_recipe(text, source)
    except Exception as e:  # CLI 超时 / API 配置错 / JSON 解析失败等，前端直接展示
        raise HTTPException(502, str(e))


# ---------- 记一餐 ----------

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean_rating(v):
    if v is None:
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise HTTPException(400, "评分要是 1-5 的整数")
    if not 1 <= n <= 5:
        raise HTTPException(400, "评分要在 1-5 之间")
    return n


def _clean_date(v) -> str:
    if not v:
        return date.today().isoformat()
    v = str(v)
    if not _DATE_RE.match(v):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise HTTPException(400, "不是有效日期")
    return v


@app.post("/api/meals")
def add_meal(body: dict):
    rid = body.get("recipe_id")
    if not rid and body.get("new_recipe", {}).get("name"):
        rid = storage.save_recipe(body["new_recipe"])["id"]
    if not rid or storage.get_recipe(rid) is None:
        raise HTTPException(400, "先选一道菜，或给新菜起个名字")
    rating = _clean_rating(body.get("rating"))
    mdate = _clean_date(body.get("date"))

    r = storage.get_recipe(rid)
    # photo_id 直接拼进路径，必须是干净 id（否则 ../ 之类脏值会永久留在 meals.json 里）
    pid = str(body.get("photo_id", "")).strip()
    if pid and not storage.valid_id(pid.lower()):
        raise HTTPException(400, "照片 id 不合法")
    card = photostore.url_for("cards", f"{pid}.png") if pid else ""  # 本地 = /photos/…（现状），COS = 完整 https
    meal = storage.add_meal({
        "recipe_id": rid,
        "date": mdate,
        "rating": rating,
        "note": str(body.get("note", ""))[:500],
        "photo_card": card,
        # 快照当次每餐热量：日后菜谱被编辑，历史食历不被追溯篡改
        "kcal": nutrition.per_serving_kcal(r),
    })
    if card and not r["cover"]:
        storage.set_cover(rid, card)
    return meal


@app.get("/api/meals")
def meals():
    rs = {r["id"]: r for r in storage.list_recipes()}
    live = {rid: nutrition.per_serving_kcal(r) for rid, r in rs.items()}
    out = []
    for m in storage.list_meals():
        # 快照优先；老记录（无快照）回退现算，行为向后兼容
        kcal = m.get("kcal")
        if kcal is None:
            kcal = live.get(m["recipe_id"])
        out.append({**m,
                    "recipe_name": rs.get(m["recipe_id"], {}).get("name") or m.get("recipe_name") or m["recipe_id"],
                    "kcal": kcal})
    # 排序键强制转字符串：手改坏的 meals.json（date 成了数字）会让比较抛 TypeError，
    # 整个端点 500、食历页永久转圈——数据脏也得让人打得开页面
    return sorted(out, key=lambda m: (str(m.get("date", "")), str(m.get("id", ""))), reverse=True)


@app.delete("/api/recipes/{rid}")
def delete_recipe(rid: str):
    """删除菜谱文件；食历记录保留（靠菜名快照继续可读），照片不删。"""
    if not storage.delete_recipe(rid):
        raise HTTPException(404, "没有这道菜")
    return {"ok": True}


# ---------- 点菜（亲友只读链接） ----------

def _notify_owner(order: dict) -> None:
    """有人点菜 → 给主人微信推一条（Server酱 sctapi）。没配 SERVERCHAN_SENDKEY 就静默不做；
    在后台线程发、失败也静默——提醒是锦上添花，绝不能挡点单落库或拖慢响应。"""
    key = os.environ.get("SERVERCHAN_SENDKEY", "").strip()
    if not key:
        return
    items = "、".join(f"{i['name']}（{i['note']}）" if i.get("note") else i["name"] for i in order["items"])
    title = f"{order['from']} 点了 {len(order['items'])} 道菜"
    desp = f"想吃：{items}"
    if order.get("note"):
        desp += f"\n\n捎话：{order['note']}"

    def _send() -> None:
        import urllib.parse
        import urllib.request
        try:
            body = urllib.parse.urlencode({"title": title, "desp": desp}).encode()
            urllib.request.urlopen(f"https://sctapi.ftqq.com/{key}.send", data=body, timeout=8)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_send, daemon=True).start()


def _orders() -> list[dict]:
    return storage.read_doc("orders") or []


def _guest_token(create: bool = False, reset: bool = False) -> str:
    cfg = storage.read_doc("config") or {}
    tok = cfg.get("guest", {}).get("token", "")
    if reset or (create and not tok):
        import secrets as _secrets

        tok = _secrets.token_urlsafe(8)
        cfg["guest"] = {"token": tok}
        storage.write_doc("config", cfg)
    return tok


def _check_guest(t: str) -> None:
    if not t or t != _guest_token():
        raise HTTPException(403, "点菜链接无效，找主人要一个新的吧")


@app.post("/api/guest-link")
def guest_link(reset: bool = False):
    return {"token": _guest_token(create=True, reset=reset)}


@app.get("/api/guest/menu")
def guest_menu(t: str):
    _check_guest(t)
    stats = storage.recipe_stats()
    # servings 也要给：kcal 这里是「每餐」值，访客拿不到 servings 就没法标「/餐」，
    # 会把 907 读成整道菜的热量（主人页有 servings 所以标了 /餐，两边口径别打架）
    out = [{k: r.get(k) for k in ("id", "name", "category", "cover", "minutes", "servings")}
           | {"times": stats.get(r["id"], {}).get("times", 0), "rating": stats.get(r["id"], {}).get("rating"),
              "kcal": nutrition.per_serving_kcal(r)}
           for r in storage.list_recipes()]
    return {"categories": storage.DEFAULT_CATEGORIES, "recipes": out}


# 点单幂等护栏：前端每次点单生成一个 client_id（uuid），超时重试复用同一个——
# 同 (guest_token, client_id) 在窗口内重复提交不再落库，返回与首次完全相同的回执。
# 进程内 dict 就够（单实例；云端缩零重启丢缓存可接受——超时重试都在分钟级窗口内）。
_IDEM_TTL = 600  # 秒：幂等窗口（10 分钟）
_idem_cache: dict[tuple[str, str], tuple[float, dict]] = {}  # (t, client_id) → (时刻, 回执)
_idem_lock = threading.Lock()


@app.post("/api/guest/order")
def guest_order(body: dict):
    t = str(body.get("t", ""))
    _check_guest(t)
    client_id = str(body.get("client_id") or "").strip()[:64]
    if client_id:  # 旧客户端不带 client_id：行为与从前完全一致
        with _idem_lock:
            hit = _idem_cache.get((t, client_id))
            if hit and time.monotonic() - hit[0] < _IDEM_TTL:
                return hit[1]  # 重试：原样回放首次回执（含首单 id），不再落库
    raw = body.get("items", [])
    if not isinstance(raw, list):
        raise HTTPException(400, "点单格式不对")
    names = {r["id"]: r["name"] for r in storage.list_recipes()}
    accepted, dropped = [], []
    for it in raw:  # 兼容两种格式：旧=菜 id 字符串；新={id, note}（每道菜可备注：少放辣…）
        rid, note = (it, "") if isinstance(it, str) else (str(it.get("id", "")), str(it.get("note", ""))) \
            if isinstance(it, dict) else ("", "")
        if rid in names:
            accepted.append({"recipe_id": rid, "name": names[rid], "note": note.strip()[:60]})
        else:
            # 菜已被主人收回（或 id 无效）：进 dropped 如实回显，不再静默吞掉
            # （客人以为点上了、主人没收到 = 静默丢失显示成功）；回显标识优先用
            # 请求里带的菜名，没有再用 id；连标识都没有的垃圾条目直接忽略
            label = (str(it.get("name", "")).strip() if isinstance(it, dict) else "") or rid.strip()
            if label:
                dropped.append(label[:60])
    if not accepted and not dropped:
        raise HTTPException(400, "先点至少一道菜")

    def _remember(resp: dict) -> dict:
        if client_id:
            with _idem_lock:
                now = time.monotonic()
                for k in [k for k, (ts, _) in _idem_cache.items() if now - ts >= _IDEM_TTL]:
                    del _idem_cache[k]  # 顺手清过期项，缓存不无界膨胀
                _idem_cache[(t, client_id)] = (now, resp)
        return resp

    if not accepted:
        # 点的菜全被收回：200 + ok:false 如实相告，不落库（请求本身没错，不该 400）
        return _remember({"ok": False, "id": None, "accepted": [], "dropped": dropped})
    orders = _orders()
    orders.append({"id": f"o{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                   "from": str(body.get("from", "")).strip()[:20] or "神秘食客",
                   "note": str(body.get("note", "")).strip()[:200],
                   "items": accepted, "date": date.today().isoformat(), "done": False})
    storage.write_doc("orders", orders)
    _notify_owner(orders[-1])
    # 旧客户端只看 ok；id/accepted/dropped 是新增字段（只增不减）：id=落库单的 id
    #（客人凭它查 /api/guest/order-status），前端成功态按回执渲染
    return _remember({"ok": True, "id": orders[-1]["id"], "accepted": accepted, "dropped": dropped})


@app.get("/api/guest/order-status")
def guest_order_status(t: str, ids: str = ""):
    """客人回执：凭点菜口令查自己单子的状态（id 客人点单时已拿到，内容本地有——
    只回状态不回单内容，不多泄）。查无的单静默跳过；一次最多 20 个防滥用。"""
    _check_guest(t)
    want = list(dict.fromkeys(s.strip() for s in ids.split(",") if s.strip()))[:20]
    by_id = {o.get("id"): o for o in _orders()}
    return {"orders": [{"id": oid, "done": bool(o.get("done")),
                        "done_date": o.get("done_date")}
                       for oid in want if (o := by_id.get(oid)) is not None]}


@app.get("/api/orders")
def list_orders():
    return sorted(_orders(), key=lambda o: o["id"], reverse=True)


@app.put("/api/orders/{oid}")
def update_order(oid: str, body: dict):
    orders = _orders()
    for o in orders:
        if o["id"] == oid:
            o["done"] = bool(body.get("done", True))
            if o["done"]:
                # 完成日（周报「本周做掉的单」按它统计）；重复标完成不刷新首次日期。
                # 旧数据无此字段，读取方需容错
                o.setdefault("done_date", date.today().isoformat())
            else:
                o.pop("done_date", None)  # 取消完成 → 完成日一并撤掉
            storage.write_doc("orders", orders)
            return o
    raise HTTPException(404, "没有这单")


# ---------- 买菜清单 ----------

@app.get("/api/shopping")
def get_shopping():
    return storage.read_doc("shopping") or {"items": []}


@app.put("/api/shopping")
def put_shopping(body: dict):
    # 服务端按 name 合并去重（前端 mergeShopping 已合并；这里兜底防绕过前端直调 API 膨胀）
    merged: dict[str, dict] = {}
    for it in body.get("items", []):
        if not isinstance(it, dict) or not it.get("name"):
            continue
        name = str(it["name"]).strip()
        if not name:
            continue
        e = merged.get(name)
        if e is None:
            merged[name] = {"name": name, "amounts": str(it.get("amounts", "")),
                            "recipes": str(it.get("recipes", "")), "checked": bool(it.get("checked")),
                            "seasoning": bool(it.get("seasoning"))}
        else:
            rs = [x for x in (e["recipes"].split("、") + str(it.get("recipes", "")).split("、")) if x]
            e["recipes"] = "、".join(dict.fromkeys(rs))
            amts = [x for x in (e["amounts"], str(it.get("amounts", ""))) if x]
            e["amounts"] = " + ".join(amts)
            e["checked"] = e["checked"] or bool(it.get("checked"))
    items = sorted(merged.values(), key=lambda x: x["seasoning"])
    doc = {"items": items}
    storage.write_doc("shopping", doc)
    return doc


@app.get("/api/weekreport")
def weekreport():
    """行为周报：做饭行为报告（规则版零 AI）——回答「这周我把日子过起来了吗」，
    不再是营养审计；营养降为一行附注 nutri_note。空周只给一句话（empty + line）。"""
    from collections import Counter

    monday = date.today() - timedelta(days=date.today().weekday())
    mon_iso = monday.isoformat()
    # 上界不能省：日期填成 2027 年的记录会永久混进「本周」（字符串比较 "2027-.." >= 本周一恒真）
    next_monday = (monday + timedelta(days=7)).isoformat()
    prev_monday = (monday - timedelta(days=7)).isoformat()
    all_meals = storage.list_meals()
    meals = [m for m in all_meals if mon_iso <= str(m.get("date", "")) < next_monday]
    last_meals = [m for m in all_meals if prev_monday <= str(m.get("date", "")) < mon_iso]
    recipes = {r["id"]: r for r in storage.list_recipes()}

    def _mname(m: dict) -> str:
        # 菜名口径：记餐时的快照优先（菜谱日后被删/改名不影响历史），再查菜谱，再退 id
        r = recipes.get(m.get("recipe_id"))
        return m.get("recipe_name") or (r["name"] if r else str(m.get("recipe_id") or ""))

    days = len({str(m["date"]) for m in meals})
    delta = len(meals) - len(last_meals) if last_meals else None  # 上周无数据 → null

    # 新面孔：全表求每道菜最早记录日期，落在本周的 → 本周首做
    first: dict[str, str] = {}
    for m in all_meals:
        rid, dt = m.get("recipe_id"), str(m.get("date", ""))
        if rid and dt:
            first[rid] = min(first.get(rid, dt), dt)
    new_dishes, _seen = [], set()
    for m in meals:
        rid = m.get("recipe_id")
        if rid and rid not in _seen and mon_iso <= first.get(rid, "") < next_monday:
            _seen.add(rid)
            new_dishes.append(_mname(m))

    # 回锅之王：本周做过 ≥2 次的第一名
    cnt = Counter(m.get("recipe_id") for m in meals if m.get("recipe_id"))
    repeat_top = None
    if cnt:
        rid, times = cnt.most_common(1)[0]
        if times >= 2:
            repeat_top = {"name": next(_mname(m) for m in meals if m.get("recipe_id") == rid),
                          "times": times}

    # 连续开火周数（含本周）：有记录的周一收进集合，从本周往回数到断
    week_set = set()
    for m in all_meals:
        try:
            d0 = date.fromisoformat(str(m.get("date", "")))
        except ValueError:
            continue  # 脏日期不参与
        week_set.add((d0 - timedelta(days=d0.weekday())).isoformat())
    streak, wk = 0, monday
    while wk.isoformat() in week_set:
        streak += 1
        wk -= timedelta(days=7)

    # 本周做掉的家人点单：done_date 落在本周（P0-2 起写入；旧单无此字段 → 自然不计）
    done_orders = [o for o in _orders()
                   if o.get("done") and mon_iso <= str(o.get("done_date", "")) < next_monday]
    froms = list(dict.fromkeys(str(o.get("from") or "神秘食客") for o in done_orders))
    orders_done = {"count": len(done_orders), "froms": froms} if done_orders else None

    five_star = list(dict.fromkeys(_mname(m) for m in meals if m.get("rating") == 5))
    photos = sum(1 for m in meals if m.get("photo_card"))

    # 营养附注一行：热量快照优先、无快照回退实时估（与 /api/meals 口径一致）；算不出给 null
    PROT = re.compile(r"肉|鸡|鸭|鹅|牛|猪|鱼|虾|蛋|豆腐|豆干|排骨|培根|火腿|贝|蟹")
    kcal_sum, kcal_meals, protein_meals = 0, 0, 0
    for m in meals:
        r = recipes.get(m.get("recipe_id"))
        k = m.get("kcal")
        if k is None and r is not None:
            k = nutrition.per_serving_kcal(r)
        if k is not None:
            kcal_sum += k
            kcal_meals += 1
        if r is not None and any(PROT.search(i["name"]) for i in r["ingredients"]):
            protein_meals += 1
    nutri_note = (f"≈{round(kcal_sum / kcal_meals)} kcal/餐均 · 蛋白餐 {protein_meals}"
                  if kcal_meals else None)

    # tip：六级优先规则取第一条（朱批口吻，温和不审判）
    if streak >= 3:
        tip = f"连着 {streak} 周灶上有火，过日子的样子"
    elif new_dishes:
        tip = (f"本周添了『{new_dishes[0]}』，档案又厚一页" if len(new_dishes) == 1
               else f"本周添了『{new_dishes[0]}』等 {len(new_dishes)} 道新菜，档案又厚几页")
    elif orders_done:
        tip = "家里点的菜都做齐了，厨房有人惦记"
    elif delta is not None and delta >= 2:
        tip = f"比上周多开了 {delta} 次火"
    elif len(meals) <= 2:
        tip = "这周外食多了些，下周回来开两次火？"
    else:
        tip = "细水长流，记着就好"

    return {"empty": not meals, "line": "这周没开火，歇着也好" if not meals else None,
            "meals": len(meals), "days": days, "delta_meals": delta,
            "new_dishes": new_dishes, "repeat_top": repeat_top, "streak_weeks": streak,
            "orders_done": orders_done, "five_star": five_star, "photos": photos,
            "nutri_note": nutri_note, "tip": tip}


@app.get("/api/monthcard/{month}")
def month_card(month: str):
    """月度食单回忆卡：YYYY-MM → 一张可保存分享的小结图。"""
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):  # 挡住非法月份，别让渲染里 int() 崩成 500
        raise HTTPException(404, "月份格式不对（应为 YYYY-MM）")
    from . import monthcard

    try:
        png = monthcard.render(month)
    except ValueError as e:
        raise HTTPException(404, str(e))
    from fastapi.responses import Response

    return Response(png, media_type="image/png")


@app.get("/api/menuposter")
def menu_poster(style: str = "family", page: int = 1):
    """纸上食单长图：整本食单 → 一张可保存可晒的竖长图（style 选题签：家宴/二人/一人食）。
    ≤18 道一张整图；更多则每页 12 道，page 翻页，总页数见响应头 X-Total-Pages。"""
    from . import menuposter
    from fastapi.responses import Response

    try:
        png, pages = menuposter.render(style, page)
    except (ValueError, LookupError) as e:
        raise HTTPException(404, str(e))
    return Response(png, media_type="image/png", headers={"X-Total-Pages": str(pages)})


@app.get("/api/recipecard/{rid}")
def recipe_card(rid: str):
    """插画教程卡：单道菜 → 一张竖版可保存分享的教程长卡（PNG，宽 1080 高自适应）。"""
    from . import recipecard
    from fastapi.responses import Response

    try:
        png = recipecard.render(rid)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return Response(png, media_type="image/png")


@app.put("/api/meals/{mid}")
def update_meal(mid: str, body: dict):
    # 与 POST 用同一套校验：改记录曾是无校验直写入口，清空日期就能把非法值落库，
    # 之后 /api/meals 按 date 排序会崩 500，食历页永久转圈（第3轮 agent 实测）
    patch = dict(body)
    if "date" in patch:
        if not patch["date"]:  # 建记录时空日期默认今天是合理的；改记录时清空不该把它悄悄搬到今天
            raise HTTPException(400, "日期不能为空")
        patch["date"] = _clean_date(patch["date"])
    if "rating" in patch:
        patch["rating"] = _clean_rating(patch["rating"])
    if "note" in patch:
        patch["note"] = str(patch["note"])[:500]
    m = storage.update_meal(mid, patch)
    if m is None:
        raise HTTPException(404, "没有这条记录")
    return m


@app.delete("/api/meals/{mid}")
def delete_meal(mid: str):
    if not storage.delete_meal(mid):
        raise HTTPException(404, "没有这条记录")
    return {"ok": True}


@app.post("/api/seed-examples")
def seed_examples():
    """把 examples/recipes/ 灌进菜谱库（幂等），给新用户十秒看到完整形态。
    文件模式=原样拷贝文件（字节不动，现状）；DB 模式=解析后插入。"""
    src = storage.ROOT / "examples" / "recipes"
    n = 0
    for f in sorted(src.glob("*.md")):
        if storage.seed_recipe(f):
            n += 1
    return {"added": n}


@app.delete("/api/seed-examples")
def remove_seed_examples():
    """一键收走示例菜：demo 集合内且无任何食历记录关联的删除；记过餐的保留
    （那已经是用户自己的菜了）。照片不删——与 delete_recipe 语义一致。主人接口。"""
    used = {m.get("recipe_id") for m in storage.list_meals()}
    removed = kept = 0
    for r in storage.list_recipes():
        if not _is_demo(r):  # 内容被改过的示例已是用户的菜，绝不收（同 demo 标记口径）
            continue
        if r["id"] in used:
            kept += 1
        elif storage.delete_recipe(r["id"]):
            removed += 1
    return {"removed": removed, "kept": kept}


# ---------- 静态 ----------

app.mount("/photos", StaticFiles(directory=storage.PHOTOS), name="photos")

DIST = storage.ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    _DIST_ROOT = DIST.resolve()

    @app.get("/{path:path}")
    def spa(path: str):
        # 未匹配到的 api 路径别回退 HTML 首页（会误导 API 客户端），明确 404 JSON。
        # 大小写与裸 /api 都要盖住：macOS 上 /API/xxx 同样会被当接口调
        low = path.lower()
        if low == "api" or low.startswith("api/"):
            raise HTTPException(404, "接口不存在")
        if path:
            f = (DIST / path).resolve()
            # 防目录穿越：解析后必须仍在 dist 内，否则一律回退首页
            if f.is_file() and f.is_relative_to(_DIST_ROOT):
                return FileResponse(f)
        return FileResponse(DIST / "index.html")
