"""文件数据库：菜谱 = data/recipes/*.md（frontmatter + 分节正文），吃饭记录 = data/meals.json。

所有数据都是 AI 助手 / 人可直接编辑的纯文本，改文件即改数据。
"""
from __future__ import annotations

import json
import re
import threading
import unicodedata
from datetime import date, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RECIPES_DIR = DATA / "recipes"
MEALS_FILE = DATA / "meals.json"
PHOTOS = DATA / "photos"

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
        name, _, amount = (s.strip() for s in line.partition("|"))
        ingredients.append({"name": name, "amount": amount})

    steps = []
    for line in sections.get("步骤", "").splitlines():
        line = line.strip()
        m = re.match(r"^\d+[.、]\s*(.+)$", line)
        if m:
            steps.append(m.group(1).strip())
        elif line and steps:  # 多行步骤续行
            steps[-1] += line

    tips = [ln.strip().lstrip("-").strip() for ln in sections.get("贴士", "").splitlines() if ln.strip()]

    return {
        "id": meta.get("id", ""),
        "name": meta.get("name", ""),
        "category": meta.get("category", DEFAULT_CATEGORIES[0]),
        "cover": meta.get("cover") or "",
        "source": meta.get("source") or "",
        "created": str(meta.get("created") or ""),
        "ingredients": ingredients,
        "steps": steps,
        "tips": tips,
    }


def _dump_md(r: dict) -> str:
    meta = {k: r[k] for k in ("id", "name", "category") if r.get(k) is not None}
    for k in ("cover", "source", "created"):
        if r.get(k):
            meta[k] = r[k]
    fm = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip()
    lines = [f"---\n{fm}\n---", "", "## 食材", ""]
    lines += [f"- {i['name']}" + (f" | {i['amount']}" if i.get("amount") else "") for i in r.get("ingredients", [])]
    lines += ["", "## 步骤", ""]
    lines += [f"{n}. {s}" for n, s in enumerate(r.get("steps", []), 1)]
    if r.get("tips"):
        lines += ["", "## 贴士", ""] + [f"- {t}" for t in r["tips"]]
    return "\n".join(lines) + "\n"


def slugify(name: str) -> str:
    """中文名 → 拼音无关的稳定 slug：保留字母数字，其余转拼接；重名加序号。"""
    ascii_part = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()).strip("-")
    slug = ascii_part or f"r{abs(hash(name)) % 100000}"
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
    # 插画目录约定：data/photos/illust/<rid>/ing-<n>.png、step-<n>.png、cover.png
    illust = PHOTOS / "illust" / rid
    r["illust"] = {
        "ingredients": [f"/photos/illust/{rid}/{f.name}" if (f := illust / f"ing-{n}.png").exists() else ""
                        for n in range(1, len(r["ingredients"]) + 1)],
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
        meal["id"] = f"m{datetime.now().strftime('%Y%m%d%H%M%S')}"
        meals.append(meal)
        _write_meals(meals)
    return meal


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
        kept = [m for m in meals if m["id"] != mid]
        if len(kept) == len(meals):
            return False
        _write_meals(kept)
    return True


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
