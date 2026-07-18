"""月度食单回忆卡：把一个月的食历汇成一张纸上小结图（Pillow 合成，纸底+朱砂+楷体）。"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from . import storage

W, H = 1080, 1440
PAPER = (244, 239, 227)
CARD = (253, 250, 243)
INK = (47, 42, 34)
DIM = (141, 130, 113)
RED = (176, 57, 43)
CN_MONTH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"]
SERIF = "/System/Library/Fonts/Songti.ttc"


def _font(size: int, index: int = 0):
    return ImageFont.truetype(SERIF, size, index=index)


def _rounded(im: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *im.size], radius=radius, fill=255)
    im.putalpha(mask)
    return im


def render(month: str) -> bytes:
    meals = [m for m in storage.list_meals() if m["date"].startswith(month)]
    if not meals:
        raise ValueError(f"{month} 没有记录")
    recipes = {r["id"]: r for r in storage.list_recipes()}

    made_ids = {m["recipe_id"] for m in meals}
    first_dates: dict[str, str] = {}
    for m in sorted(storage.list_meals(), key=lambda x: x["date"]):
        first_dates.setdefault(m["recipe_id"], m["date"])
    unlocked = [rid for rid in made_ids if first_dates.get(rid, "").startswith(month)]
    rated = [m for m in meals if m.get("rating")]
    best = max(rated, key=lambda m: (m["rating"], m["date"])) if rated else None

    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # 印章 + 标题
    d.rounded_rectangle([80, 80, 148, 148], radius=10, fill=RED)
    f_seal = _font(40)
    d.text((114 - f_seal.getlength("箪") / 2, 92), "箪", font=f_seal, fill=CARD)
    mn = CN_MONTH[int(month[5:7]) - 1]
    d.text((80, 190), f"{mn}月食单", font=_font(84), fill=INK)
    d.text((84, 300), f"{month.replace('-', ' · ')}", font=_font(30), fill=DIM)

    # 统计行
    stats = f"记了 {len(meals)} 餐 · 做了 {len(made_ids)} 道菜 · 新解锁 {len(unlocked)} 道"
    d.text((80, 370), stats, font=_font(38), fill=RED)

    # 菜卡九宫格（最多 9 张，按时间倒序）
    thumbs = []
    for m in sorted(meals, key=lambda x: (x["date"], x["id"]), reverse=True):
        p = storage.PHOTOS / m["photo_card"].removeprefix("/photos/") if m.get("photo_card") else None
        if p and p.exists():
            thumbs.append(p)
        if len(thumbs) == 9:
            break
    cell, gap, x0, y0 = 296, 16, 80, 460
    for i, p in enumerate(thumbs):
        t = Image.open(p).convert("RGBA").resize((cell, cell), Image.LANCZOS)
        t = _rounded(t, 24)
        img.paste(t, (x0 + (i % 3) * (cell + gap), y0 + (i // 3) * (cell + gap)), t)

    rows = max(1, (len(thumbs) + 2) // 3)
    y = y0 + rows * (cell + gap) + 24

    # 本月最佳
    if best:
        name = recipes.get(best["recipe_id"], {}).get("name", "")
        d.text((80, y), f"本月最佳：{name} {'★' * int(best['rating'])}", font=_font(40), fill=INK)
        y += 70

    # 底部落款
    d.line([(80, H - 120), (W - 80, H - 120)], fill=(47, 42, 34, 40), width=2)
    d.text((80, H - 100), "一箪食 · 记录自己做的每一顿饭", font=_font(28), fill=DIM)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
