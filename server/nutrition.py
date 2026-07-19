"""营养数据库：三级来源，逐级兜底，条条标明出处。

1. 内置库 server/assets/nutrition-db.json —— 按《中国食物成分表(第6版)》常见参考值精编，
   随仓库维护（欢迎校正/PR），含默认克重 default_g
2. 用户缓存 data/ingredients/<名>.json —— AI 兜底生成过的条目
3. AI 兜底 —— 都没有时现场生成并落入用户缓存，source 标「AI 估算」
"""
from __future__ import annotations

import json
from pathlib import Path

from . import storage

DB_FILE = Path(__file__).parent / "assets" / "nutrition-db.json"
USER_DIR = storage.DATA / "ingredients"
AI_SOURCE = "AI 估算（参考《中国食物成分表》口径，仅供参考）"

_db: dict | None = None


def builtin() -> dict:
    global _db
    if _db is None:
        _db = json.loads(DB_FILE.read_text(encoding="utf-8"))
    return _db


def lookup(name: str) -> dict | None:
    """内置库优先精确匹配，再做包含匹配（「鸡翅中8个」里的名能落到「鸡翅中」；取最长命中）。"""
    db = builtin()
    if name in db:
        return {"name": name, **db[name]}
    hits = [k for k in db if k in name or name in k]
    if hits:
        k = max(hits, key=len)
        return {"name": name, **db[k], "matched": k}
    return None


def cached(name: str) -> dict | None:
    p = USER_DIR / f"{name}.json"
    if p.exists():
        info = json.loads(p.read_text(encoding="utf-8"))
        info.setdefault("source", AI_SOURCE)
        return info
    return None


def all_names() -> list[str]:
    names = list(builtin().keys())
    if USER_DIR.exists():
        names += [p.stem for p in USER_DIR.glob("*.json") if p.stem not in builtin()]
    return sorted(set(names))


def compute(ingredients: list[dict]) -> dict | None:
    """按食材克重合计营养。只统计「有克重且查得到数据」的食材，并报告覆盖度。"""
    total = {"kcal": 0.0, "protein_g": 0.0, "fat_g": 0.0, "carb_g": 0.0}
    covered = 0
    for ing in ingredients:
        g = ing.get("grams")
        if not g:
            continue
        info = lookup(ing["name"]) or cached(ing["name"])
        if not info or info.get("kcal_per_100g") is None:
            continue
        covered += 1
        f = g / 100.0
        total["kcal"] += (info.get("kcal_per_100g") or 0) * f
        total["protein_g"] += (info.get("protein_g") or 0) * f
        total["fat_g"] += (info.get("fat_g") or 0) * f
        total["carb_g"] += (info.get("carb_g") or 0) * f
    if covered == 0:
        return None
    return {"kcal": round(total["kcal"]), "protein_g": round(total["protein_g"], 1),
            "fat_g": round(total["fat_g"], 1), "carb_g": round(total["carb_g"], 1),
            "covered": covered, "total": len(ingredients)}
