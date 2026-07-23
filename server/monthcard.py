"""月度食单回忆卡：把一个月的食历汇成一张纸上小结图（Pillow 合成，纸底+朱砂+楷体）。"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from . import photostore, storage

W, H = 1080, 1440
PAPER = (244, 239, 227)
CARD = (253, 250, 243)
INK = (47, 42, 34)
DIM = (141, 130, 113)
RED = (176, 57, 43)
CN_MONTH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"]
SERIF = "/System/Library/Fonts/Songti.ttc"


def _font(size: int, index: int = 0):
    # index 是「字体集内第几个字面」——mac Songti.ttc 有 7 个面（调用方会传 1/6），
    # 云上的 Noto .ttc 面数不同：请求的面不存在时必须退回 0 号面，否则一路漏到豆腐块
    #（真机教程卡全 tofu 事故的第二根保险丝；第一根是 Dockerfile 装字体）。
    paths = [SERIF, "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
             "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]
    import glob as _glob
    paths += sorted(_glob.glob("/usr/share/fonts/**/*CJK*.tt[cf]", recursive=True)
                    + _glob.glob("/usr/share/fonts/**/*cjk*.tt[cf]", recursive=True))
    for path in paths:
        for idx in (index, 0) if index else (0,):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except OSError:
                continue
    return ImageFont.load_default(size)  # 真没有字体时的最后兜底（中文会是豆腐块）


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
    # 只认 1-5 的整数评分：历史脏数据里若混进字符串评分，max 比较会抛 TypeError 让整张卡 500
    rated = [m for m in meals if isinstance(m.get("rating"), int) and not isinstance(m["rating"], bool)
             and 1 <= m["rating"] <= 5]
    best = max(rated, key=lambda m: (m["rating"], str(m.get("date", "")))) if rated else None

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

    # 菜卡九宫格（最多 9 张，按时间倒序）。photo_card 是 http(s)（云端 COS）就拉字节
    # （超时 5s，失败跳过该缩略图），否则按本地路径（现状）——photostore.fetch 统一处理
    thumbs: list[Image.Image] = []
    for m in sorted(meals, key=lambda x: (x["date"], x["id"]), reverse=True):
        data = photostore.fetch(m.get("photo_card") or "")
        if data:
            try:
                thumbs.append(Image.open(io.BytesIO(data)).convert("RGBA"))
            except Exception:  # 坏图/半截下载：跳过这张，别让整张月卡 500
                pass
        if len(thumbs) == 9:
            break
    # 满 3 行时缩小格子：296 的格子排三行会盖住底部落款、并把「本月最佳」整行挤出画布
    rows = max(1, (len(thumbs) + 2) // 3)
    cell, gap, y0 = (296 if rows <= 2 else 240), 16, 460
    x0 = (W - (3 * cell + 2 * gap)) // 2
    for i, t in enumerate(thumbs):
        t = _rounded(t.resize((cell, cell), Image.LANCZOS), 24)
        img.paste(t, (x0 + (i % 3) * (cell + gap), y0 + (i // 3) * (cell + gap)), t)

    y = y0 + rows * (cell + gap) + 24

    # 本月最佳
    if best:
        # 菜谱被删时回退到记餐时的菜名快照，别渲染成「本月最佳：  ★★★★★」
        name = (recipes.get(best["recipe_id"], {}).get("name")
                or best.get("recipe_name") or best.get("recipe_id", ""))
        d.text((80, y), f"本月最佳：{name} {'★' * int(best['rating'])}", font=_font(40), fill=INK)
        y += 70

    # 底部落款
    d.line([(80, H - 120), (W - 80, H - 120)], fill=(47, 42, 34, 40), width=2)
    d.text((80, H - 100), "一箪食 · 记录自己做的每一顿饭", font=_font(28), fill=DIM)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
