"""一箪食 · 后端。启动：scripts/dev.sh 或 .venv/bin/uvicorn server.app:app --port 18100"""
from __future__ import annotations

import json
import os
import random
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import cutout, imagegen, llm, storage

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


# ---------- 设置 ----------

def _config_payload() -> dict:
    cfg = json.loads(llm.CONFIG_FILE.read_text(encoding="utf-8")) if llm.CONFIG_FILE.exists() else {}
    envs = {c.get("api_key_env") for c in (cfg.get("llm", {}), cfg.get("imagegen", {})) if c.get("api_key_env")}
    return {"llm": cfg.get("llm", {}), "imagegen": cfg.get("imagegen", {}),
            "status": {**llm.backend_status(), "imagegen": imagegen.backend_status()},
            "secrets": {e: bool(os.environ.get(e)) for e in envs}}


@app.get("/api/config")
def get_config():
    return _config_payload()


@app.put("/api/config")
def put_config(body: dict):
    cfg = {}
    for section in ("llm", "imagegen"):
        clean = {k: v for k, v in (body.get(section) or {}).items() if v not in ("", None)}
        if clean:
            cfg[section] = clean
    llm.CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    secrets = {k: v.strip() for k, v in (body.get("secrets") or {}).items() if v and v.strip()}
    if secrets:
        lines = _SECRETS_FILE.read_text(encoding="utf-8").splitlines() if _SECRETS_FILE.exists() else []
        kept = [ln for ln in lines if not any(ln.strip().startswith(f"{k}=") for k in secrets)]
        kept += [f"{k}={v}" for k, v in secrets.items()]
        _SECRETS_FILE.write_text("\n".join(kept) + "\n", encoding="utf-8")
        os.environ.update(secrets)
    return _config_payload()


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
    # 朱批：这道菜历次记录的备注，红批注上教程卡
    notes = [{"date": m["date"], "note": m["note"]}
             for m in storage.list_meals() if m["recipe_id"] == rid and m.get("note")]
    return {**r, "times": s.get("times", 0), "rating": s.get("rating"),
            "annotations": sorted(notes, key=lambda n: n["date"], reverse=True)[:5]}


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


PANTRY_FILE = storage.DATA / "pantry.json"


def _pantry() -> list[str]:
    return json.loads(PANTRY_FILE.read_text(encoding="utf-8")).get("items", []) if PANTRY_FILE.exists() else []


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
    PANTRY_FILE.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"items": items}


@app.get("/api/random")
def random_pick(category: str | None = None, avoid_days: int = 0, max_minutes: int = 0,
                difficulty: str = "", use_pantry: int = 0):
    """翻牌子：avoid_days=N 排除最近 N 天做过的；max_minutes=M 只要 M 分钟内能做的；
    difficulty=简单 只要省事的；use_pantry=1 优先冰箱里有食材的菜。
    条件内没菜时逐级放宽并带 relaxed 标记，绝不空手而归。"""
    rs = [r for r in storage.list_recipes() if category in (None, "", r["category"])]
    if not rs:
        raise HTTPException(404, "菜单还是空的")
    relaxed = False
    if avoid_days > 0:
        cutoff = (date.today() - timedelta(days=avoid_days)).isoformat()
        recent = {m["recipe_id"] for m in storage.list_meals() if m["date"] >= cutoff}
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


# ---------- 抠图 ----------

@app.post("/api/cutout")
async def do_cutout(photo: UploadFile = File(...), already_cut: bool = Form(False),
                    mode: str = Form("auto"), cx: float = Form(-1), cy: float = Form(-1), r: float = Form(-1)):
    """mode: plate=抠出食物摆插画盘 / auto=AI抠图直出 / circle=参考圆直裁 / both=全都出让用户选 /
    polish=AI 图生图精修原照片；cx/cy/r 为参考圆相对坐标。"""
    raw = await photo.read()
    stamp = datetime.now().strftime("p%Y%m%d%H%M%S%f")
    ext = Path(photo.filename or "x.jpg").suffix or ".jpg"
    (storage.PHOTOS / "raw" / f"{stamp}{ext}").write_bytes(raw)
    circle = (cx, cy, r) if r > 0 else None

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
        results = cutout.process_modes(raw, modes, circle)

    out = []
    for m, (cut_png, card_png) in results.items():
        pid = f"{stamp}-{m}"
        (storage.PHOTOS / "cut" / f"{pid}.png").write_bytes(cut_png)
        (storage.PHOTOS / "cards" / f"{pid}.png").write_bytes(card_png)
        out.append({"mode": m, "photo_id": pid, "card": f"/photos/cards/{pid}.png"})
    return {"results": out}


@app.post("/api/replate")
def replate(body: dict):
    """换餐具：用已存的抠图重新合成菜卡（本地零成本）。tableware ∈ plate/bowl/saucer。"""
    pid, tw = body.get("photo_id", ""), body.get("tableware", "plate")
    cutf = storage.PHOTOS / "cut" / f"{pid}.png"
    if not cutf.exists():
        raise HTTPException(404, "没有这张抠图")
    from PIL import Image

    card = cutout.make_plate_card(Image.open(cutf).convert("RGBA"), tw)
    (storage.PHOTOS / "cards" / f"{pid}.png").write_bytes(cutout._png(card))
    return {"card": f"/photos/cards/{pid}.png", "tableware": tw}


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
    rs = {r["id"]: r for r in storage.list_recipes()}
    out = [{**m,
            "recipe_name": rs.get(m["recipe_id"], {}).get("name") or m.get("recipe_name") or m["recipe_id"],
            "kcal": rs.get(m["recipe_id"], {}).get("kcal")} for m in storage.list_meals()]
    return sorted(out, key=lambda m: (m["date"], m["id"]), reverse=True)


@app.delete("/api/recipes/{rid}")
def delete_recipe(rid: str):
    """删除菜谱文件；食历记录保留（靠菜名快照继续可读），照片不删。"""
    if not storage.delete_recipe(rid):
        raise HTTPException(404, "没有这道菜")
    return {"ok": True}


# ---------- 点菜（亲友只读链接） ----------

ORDERS_FILE = storage.DATA / "orders.json"


def _orders() -> list[dict]:
    return json.loads(ORDERS_FILE.read_text(encoding="utf-8")) if ORDERS_FILE.exists() else []


def _guest_token(create: bool = False, reset: bool = False) -> str:
    cfg = json.loads(llm.CONFIG_FILE.read_text(encoding="utf-8")) if llm.CONFIG_FILE.exists() else {}
    tok = cfg.get("guest", {}).get("token", "")
    if reset or (create and not tok):
        import secrets as _secrets

        tok = _secrets.token_urlsafe(8)
        cfg["guest"] = {"token": tok}
        llm.CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    out = [{k: r.get(k) for k in ("id", "name", "category", "cover", "kcal", "minutes")}
           | {"times": stats.get(r["id"], {}).get("times", 0), "rating": stats.get(r["id"], {}).get("rating")}
           for r in storage.list_recipes()]
    return {"categories": storage.DEFAULT_CATEGORIES, "recipes": out}


@app.post("/api/guest/order")
def guest_order(body: dict):
    _check_guest(body.get("t", ""))
    names = {r["id"]: r["name"] for r in storage.list_recipes()}
    items = [{"recipe_id": rid, "name": names[rid]} for rid in body.get("items", []) if rid in names]
    if not items:
        raise HTTPException(400, "先点至少一道菜")
    orders = _orders()
    orders.append({"id": f"o{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                   "from": str(body.get("from", "")).strip()[:20] or "神秘食客",
                   "note": str(body.get("note", "")).strip()[:200],
                   "items": items, "date": date.today().isoformat(), "done": False})
    ORDERS_FILE.write_text(json.dumps(orders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"ok": True}


@app.get("/api/orders")
def list_orders():
    return sorted(_orders(), key=lambda o: o["id"], reverse=True)


@app.put("/api/orders/{oid}")
def update_order(oid: str, body: dict):
    orders = _orders()
    for o in orders:
        if o["id"] == oid:
            o["done"] = bool(body.get("done", True))
            ORDERS_FILE.write_text(json.dumps(orders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            return o
    raise HTTPException(404, "没有这单")


# ---------- 买菜清单 ----------

SHOPPING_FILE = storage.DATA / "shopping.json"


@app.get("/api/shopping")
def get_shopping():
    return json.loads(SHOPPING_FILE.read_text(encoding="utf-8")) if SHOPPING_FILE.exists() else {"items": []}


@app.put("/api/shopping")
def put_shopping(body: dict):
    doc = {"items": body.get("items", [])}
    SHOPPING_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return doc


@app.get("/api/weekreport")
def weekreport():
    """营养轻周报：规则版（零成本零延迟），温和提示不审判。"""
    import re as _re
    from collections import Counter

    monday = date.today() - timedelta(days=date.today().weekday())
    meals = [m for m in storage.list_meals() if m["date"] >= monday.isoformat()]
    recipes = {r["id"]: r for r in storage.list_recipes()}
    PROT = _re.compile(r"肉|鸡|鸭|鹅|牛|猪|鱼|虾|蛋|豆腐|豆干|排骨|培根|火腿|贝|蟹")
    VEG = _re.compile(r"菜|瓜|笋|菇|芹|番茄|西红柿|萝卜|土豆|茄|豆角|芦笋|西兰花|菠菜|生菜|黄瓜|藕|山药|玉米")

    protein_meals, veg_kinds, cats = 0, set(), Counter()
    kcal = 0
    for m in meals:
        r = recipes.get(m["recipe_id"])
        if not r:
            continue
        cats[r["category"]] += 1
        kcal += r.get("kcal") or 0
        ings = [i["name"] for i in r["ingredients"]]
        if any(PROT.search(n) for n in ings):
            protein_meals += 1
        veg_kinds |= {n for n in ings if VEG.search(n)}

    if not meals:
        tip = ""
    elif len(veg_kinds) < 3:
        tip = "蔬菜种类有点少，下周添一两样绿叶菜试试？"
    elif protein_meals < max(1, len(meals) // 2):
        tip = "蛋白质可以再安排上一点（蛋豆鱼肉都算）。"
    else:
        tip = "吃得挺均衡，保持这个节奏。"
    return {"meals": len(meals), "kcal": kcal, "protein_meals": protein_meals,
            "veg_kinds": sorted(veg_kinds), "categories": dict(cats), "tip": tip}


@app.get("/api/monthcard/{month}")
def month_card(month: str):
    """月度食单回忆卡：YYYY-MM → 一张可保存分享的小结图。"""
    from . import monthcard

    try:
        png = monthcard.render(month)
    except ValueError as e:
        raise HTTPException(404, str(e))
    from fastapi.responses import Response

    return Response(png, media_type="image/png")


@app.put("/api/meals/{mid}")
def update_meal(mid: str, body: dict):
    m = storage.update_meal(mid, body)
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
    """把 examples/recipes/ 拷进 data/recipes/（幂等），给新用户十秒看到完整形态。"""
    src = storage.ROOT / "examples" / "recipes"
    n = 0
    for f in src.glob("*.md"):
        dst = storage.RECIPES_DIR / f.name
        if not dst.exists():
            dst.write_bytes(f.read_bytes())
            n += 1
    return {"added": n}


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
