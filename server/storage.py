"""文件数据库：菜谱 = data/recipes/*.md（frontmatter + 分节正文），吃饭记录 = data/meals.json。

所有数据都是 AI 助手 / 人可直接编辑的纯文本，改文件即改数据。
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import unicodedata
from datetime import date, datetime
from pathlib import Path

import yaml

try:  # 中文名转拼音 slug（可读、稳定）；没装也能跑，退确定性短哈希
    from pypinyin import lazy_pinyin
except ImportError:  # pragma: no cover
    lazy_pinyin = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RECIPES_DIR = DATA / "recipes"
MEALS_FILE = DATA / "meals.json"
PHOTOS = DATA / "photos"
ING_ICON_DIR = PHOTOS / "illust" / "ingredients"  # 食材图标全局共享库（按食材名，全食单复用）

DEFAULT_CATEGORIES = ["饭粥", "面点", "羹汤", "小炒", "甜点"]  # 随园食单章法，支持自定义追加

_lock = threading.Lock()


def init_dirs() -> None:
    for p in (RECIPES_DIR, PHOTOS / "raw", PHOTOS / "cut", PHOTOS / "cards", PHOTOS / "illust"):
        p.mkdir(parents=True, exist_ok=True)
    if not MEALS_FILE.exists():
        MEALS_FILE.write_text("[]\n", encoding="utf-8")


# ---------- 菜谱 ----------

_SECTION_RE = re.compile(r"^##\s*(食材|步骤|贴士)\s*$", re.M)


def _parse_md(text: str) -> dict:
    """frontmatter + ## 食材 / ## 步骤 / ## 贴士 三节。"""
    meta: dict = {}
    body = text
    if text.startswith("---"):
        _, fm, body = text.split("---", 2)
        meta = yaml.safe_load(fm) or {}

    sections: dict[str, str] = {}
    parts = _SECTION_RE.split(body)
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i]] = parts[i + 1].strip()

    ingredients = []
    for line in sections.get("食材", "").splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        parts = [s.strip() for s in line.split("|")]
        grams = None
        if len(parts) >= 3:  # 第三段为克重：如 "55g"
            m = re.match(r"^([\d.]+)\s*[g克]?$", parts[2])
            if m:
                grams = round(float(m.group(1)))
        ingredients.append({"name": parts[0], "amount": parts[1] if len(parts) > 1 else "", "grams": grams})

    steps = []
    for line in sections.get("步骤", "").splitlines():
        line = line.strip()
        m = re.match(r"^\d+[.、]\s*(.+)$", line)
        if m:
            steps.append(m.group(1).strip())
        elif line and steps:  # 多行步骤续行
            steps[-1] += line

    tips = [ln.strip().lstrip("-").strip() for ln in sections.get("贴士", "").splitlines() if ln.strip()]

    kcal, servings, minutes = meta.get("kcal"), meta.get("servings"), meta.get("minutes")
    return {
        "id": meta.get("id", ""),
        "name": meta.get("name", ""),
        "category": meta.get("category", DEFAULT_CATEGORIES[0]),
        "cover": meta.get("cover") or "",
        "source": meta.get("source") or "",
        "created": str(meta.get("created") or ""),
        "kcal": int(kcal) if isinstance(kcal, (int, float)) else None,
        "minutes": int(minutes) if isinstance(minutes, (int, float)) else None,
        "difficulty": meta.get("difficulty") if meta.get("difficulty") in ("简单", "中等", "硬菜") else None,
        "servings": int(servings) if isinstance(servings, (int, float)) and servings >= 1 else 1,
        "ingredients": ingredients,
        "steps": steps,
        "tips": tips,
    }


def _dump_md(r: dict) -> str:
    meta = {k: r[k] for k in ("id", "name", "category") if r.get(k) is not None}
    for k in ("cover", "source", "created", "kcal", "minutes", "difficulty"):
        if r.get(k):
            meta[k] = r[k]
    if r.get("servings") and int(r["servings"]) > 1:
        meta["servings"] = int(r["servings"])
    fm = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip()
    lines = [f"---\n{fm}\n---", "", "## 食材", ""]
    for i in r.get("ingredients", []):
        g = i.get("grams")
        g = round(g) if isinstance(g, (int, float)) and g > 0 else None  # 负/零/非法克重不落库
        line = f"- {i['name']}"
        if i.get("amount") or g:
            line += f" | {i.get('amount', '')}"
        if g:
            line += f" | {g}g"
        lines.append(line)
    lines += ["", "## 步骤", ""]
    lines += [f"{n}. {s}" for n, s in enumerate(r.get("steps", []), 1)]
    if r.get("tips"):
        lines += ["", "## 贴士", ""] + [f"- {t}" for t in r["tips"]]
    return "\n".join(lines) + "\n"


def slugify(name: str) -> str:
    """菜名 → 稳定可读 slug：中文优先转拼音，非中文原样保留；重名加序号。

    旧实现直接 encode("ascii","ignore") 会把汉字整段丢掉，全中文名一律落到
    hash 兜底（且内置 hash() 跨进程不稳定），导致大量菜名 slug 撞车。
    """
    name = (name or "").strip()
    # lazy_pinyin 逐字转拼音、非中文段原样保留；没装库则用原名（英文/数字名照常可用）
    src = " ".join(lazy_pinyin(name)) if (lazy_pinyin and name) else name
    slug = re.sub(r"[^a-z0-9]+", "-",
                  unicodedata.normalize("NFKD", src).encode("ascii", "ignore").decode().lower()).strip("-")
    slug = slug[:60].strip("-")  # 控制文件名长度
    if not slug:  # 纯符号/emoji 等无可转写字符：确定性短哈希（不用内置 hash，跨进程不稳）
        slug = "r" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    base, n = slug, 2
    while (RECIPES_DIR / f"{slug}.md").exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


def list_recipes() -> list[dict]:
    out = []
    for p in sorted(RECIPES_DIR.glob("*.md")):
        r = _parse_md(p.read_text(encoding="utf-8"))
        r["id"] = r["id"] or p.stem
        out.append(r)
    return out


def get_recipe(rid: str) -> dict | None:
    p = RECIPES_DIR / f"{rid}.md"
    if not p.exists():
        return None
    r = _parse_md(p.read_text(encoding="utf-8"))
    r["id"] = rid
    # 插画目录约定：食材图标在全局共享库 illust/ingredients/<食材名>.png（旧的按菜谱 ing-<n>.png 兼容），
    # 步骤图按菜谱 illust/<rid>/step-<n>.png
    illust = PHOTOS / "illust" / rid

    def ing_url(n: int) -> str:
        shared = ING_ICON_DIR / f"{r['ingredients'][n - 1]['name']}.png"
        if shared.exists():
            return f"/photos/illust/ingredients/{shared.name}"
        legacy = illust / f"ing-{n}.png"
        return f"/photos/illust/{rid}/{legacy.name}" if legacy.exists() else ""

    r["illust"] = {
        "ingredients": [ing_url(n) for n in range(1, len(r["ingredients"]) + 1)],
        "steps": [f"/photos/illust/{rid}/{f.name}" if (f := illust / f"step-{n}.png").exists() else ""
                  for n in range(1, len(r["steps"]) + 1)],
    }
    return r


def save_recipe(r: dict) -> dict:
    with _lock:
        if not r.get("id"):
            r["id"] = slugify(r["name"])
        if not r.get("created"):
            r["created"] = date.today().isoformat()
        (RECIPES_DIR / f"{r['id']}.md").write_text(_dump_md(r), encoding="utf-8")
    return r


def set_cover(rid: str, cover: str) -> None:
    r = get_recipe(rid)
    if r is not None:
        r["cover"] = cover
        save_recipe(r)


# ---------- 吃饭记录 ----------

def list_meals() -> list[dict]:
    return json.loads(MEALS_FILE.read_text(encoding="utf-8"))


def _write_meals(meals: list[dict]) -> None:
    MEALS_FILE.write_text(json.dumps(meals, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def add_meal(meal: dict) -> dict:
    with _lock:
        meals = list_meals()
        # 唯一 id：秒级时间戳 + 短随机后缀，杜绝同秒双击/重试碰撞（碰撞会导致删除连坐）
        used = {m.get("id") for m in meals}
        base = f"m{datetime.now().strftime('%Y%m%d%H%M%S')}"
        mid = base
        while mid in used:
            mid = f"{base}-{secrets.token_hex(2)}"
        meal["id"] = mid
        # 快照菜名：菜谱日后被删/改名，食历记录依然可读
        r = get_recipe(meal.get("recipe_id", ""))
        if r is not None:
            meal.setdefault("recipe_name", r["name"])
        meals.append(meal)
        _write_meals(meals)
    return meal


def delete_recipe(rid: str) -> bool:
    p = RECIPES_DIR / f"{rid}.md"
    if not p.exists():
        return False
    p.unlink()
    return True


def update_meal(mid: str, patch: dict) -> dict | None:
    with _lock:
        meals = list_meals()
        for m in meals:
            if m["id"] == mid:
                m.update({k: patch[k] for k in ("date", "rating", "note") if k in patch})
                _write_meals(meals)
                return m
    return None


def delete_meal(mid: str) -> bool:
    with _lock:
        meals = list_meals()
        # 只删第一条匹配：历史数据可能存在同 id（老版本秒级 id 碰撞），避免一次连坐删多条
        for i, m in enumerate(meals):
            if m["id"] == mid:
                del meals[i]
                _write_meals(meals)
                return True
    return False


def recipe_stats() -> dict[str, dict]:
    """recipe_id → {times, rating}"""
    stats: dict[str, dict] = {}
    for m in list_meals():
        s = stats.setdefault(m.get("recipe_id", ""), {"times": 0, "ratings": []})
        s["times"] += 1
        if m.get("rating") is not None:
            s["ratings"].append(m["rating"])
    return {
        rid: {"times": s["times"],
              "rating": round(sum(s["ratings"]) / len(s["ratings"]), 1) if s["ratings"] else None}
        for rid, s in stats.items()
    }
