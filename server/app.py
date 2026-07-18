"""一箪食 · 后端。启动：scripts/dev.sh 或 .venv/bin/uvicorn server.app:app --port 18100"""
from __future__ import annotations

import random
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import cutout, storage

app = FastAPI(title="一箪食 yidanshi")
storage.init_dirs()


# ---------- 菜谱 ----------

@app.get("/api/recipes")
def recipes():
    stats = storage.recipe_stats()
    out = []
    for r in storage.list_recipes():
        s = stats.get(r["id"], {})
        out.append({**r, "times": s.get("times", 0), "rating": s.get("rating")})
    return {"categories": storage.DEFAULT_CATEGORIES, "recipes": out}


@app.get("/api/recipes/{rid}")
def recipe(rid: str):
    r = storage.get_recipe(rid)
    if r is None:
        raise HTTPException(404, "no such recipe")
    s = storage.recipe_stats().get(rid, {})
    return {**r, "times": s.get("times", 0), "rating": s.get("rating")}


@app.post("/api/recipes")
def create_recipe(body: dict):
    if not body.get("name"):
        raise HTTPException(400, "name required")
    return storage.save_recipe(body)


@app.put("/api/recipes/{rid}")
def update_recipe(rid: str, body: dict):
    if storage.get_recipe(rid) is None:
        raise HTTPException(404, "no such recipe")
    body["id"] = rid
    return storage.save_recipe(body)


@app.get("/api/random")
def random_pick(category: str | None = None):
    rs = [r for r in storage.list_recipes() if category in (None, "", r["category"])]
    if not rs:
        raise HTTPException(404, "菜单还是空的")
    return random.choice(rs)


# ---------- 抠图 ----------

@app.post("/api/cutout")
async def do_cutout(photo: UploadFile = File(...), already_cut: bool = Form(False)):
    raw = await photo.read()
    pid = datetime.now().strftime("p%Y%m%d%H%M%S%f")
    cut_png, card_png = cutout.process(raw, already_cut=already_cut)

    ext = Path(photo.filename or "x.jpg").suffix or ".jpg"
    (storage.PHOTOS / "raw" / f"{pid}{ext}").write_bytes(raw)
    (storage.PHOTOS / "cut" / f"{pid}.png").write_bytes(cut_png)
    (storage.PHOTOS / "cards" / f"{pid}.png").write_bytes(card_png)
    return {"photo_id": pid, "raw": f"/photos/raw/{pid}{ext}",
            "cut": f"/photos/cut/{pid}.png", "card": f"/photos/cards/{pid}.png"}


# ---------- 记一餐 ----------

@app.post("/api/meals")
def add_meal(body: dict):
    rid = body.get("recipe_id")
    if not rid and body.get("new_recipe", {}).get("name"):
        rid = storage.save_recipe(body["new_recipe"])["id"]
    if not rid or storage.get_recipe(rid) is None:
        raise HTTPException(400, "recipe_id or new_recipe required")

    card = f"/photos/cards/{body['photo_id']}.png" if body.get("photo_id") else ""
    meal = storage.add_meal({
        "recipe_id": rid,
        "date": body.get("date") or date.today().isoformat(),
        "rating": body.get("rating"),
        "note": body.get("note", ""),
        "photo_card": card,
    })
    r = storage.get_recipe(rid)
    if card and not r["cover"]:
        storage.set_cover(rid, card)
    return meal


@app.get("/api/meals")
def meals():
    names = {r["id"]: r["name"] for r in storage.list_recipes()}
    out = [{**m, "recipe_name": names.get(m["recipe_id"], m["recipe_id"])} for m in storage.list_meals()]
    return sorted(out, key=lambda m: (m["date"], m["id"]), reverse=True)


# ---------- 静态 ----------

app.mount("/photos", StaticFiles(directory=storage.PHOTOS), name="photos")

DIST = storage.ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
