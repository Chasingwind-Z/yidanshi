"""纸上食单长图：把整本菜谱按分类排成一张可晒的竖长图（Pillow 合成，纸底+朱砂+楷体）。

版式自上而下：题签封面（竖排大字 + 年月小字 + 朱砂方印 + 朱批统计）→ 按分类分帖
（楷体小标 + 朱砂细线 + 单菜行：抠图菜照 + 菜名 + 档案戳）→ 候膳（未做的点单，
朱批小字，只在有单时出现）→ 落款（小朱印 + 一箪食）。不放二维码/链接/水印。
分页规则采竞品验证值：总菜数 ≤18 一张整图，超过则每页 12 道（page 参数）。
"""
from __future__ import annotations

import glob
import io
from datetime import date

from PIL import Image, ImageDraw, ImageFont

from . import nutrition, photostore, storage

W = 1200
PAPER = (244, 239, 227)
CARD = (253, 250, 243)
INK = (47, 42, 34)
DIM = (141, 130, 113)
RED = (176, 57, 43)
HAIR = (213, 202, 180)          # 纸面细线
FRAME = (196, 183, 158)         # 文武边外框
SERIF = "/System/Library/Fonts/Songti.ttc"

STYLES = {"family": "家宴食单", "couple": "二人小灶", "solo": "一人食帖"}
DIRECT_MAX, PAGE_SIZE = 18, 12  # 竞品验证值：≤18 道一张整图，多则每页 12 道
CN_DIGIT = "〇一二三四五六七八九"


def _font(size: int, index: int = 0):
    for path in (SERIF, "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default(size)  # 非 mac/无中文字体时兜底（字形较糙但可用）


def _song(size: int, bold: bool = False):
    return _font(size, index=1 if bold else 6)  # mac Songti.ttc：1=SC Bold，6=SC Regular


def _kai(size: int, bold: bool = False):
    """楷体优先（mac 的 Kaiti.ttc 在按需字体资产目录里，路径带机器哈希，glob 找）；
    没有楷体时回退宋体——版式不变，只是笔意少一点。"""
    for path in sorted(glob.glob(
            "/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/Kaiti.ttc")):
        try:
            return ImageFont.truetype(path, size, index=3 if bold else 0)  # 0=Kaiti SC，3=SC Bold
        except OSError:
            continue
    return _song(size, bold)


def _rounded(im: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *im.size], radius=radius, fill=255)
    im.putalpha(mask)
    return im


def _cn(n: int) -> str:
    """1-99 的汉字数（十/二十三），封面统计、卷号、每帖品数用。"""
    if n < 10:
        return CN_DIGIT[n]
    tens, ones = divmod(n, 10)
    return ("" if tens == 1 else CN_DIGIT[tens]) + "十" + (CN_DIGIT[ones] if ones else "")


def _placeholder(cell: int) -> Image.Image:
    """封面缺失/拉取失败的占位：灰圈 + 🍚（emoji 字体没有就画个「饭」字），绝不让整图 500。"""
    im = Image.new("RGBA", (cell, cell), CARD + (255,))
    d = ImageDraw.Draw(im)
    pad = int(cell * 0.14)
    d.ellipse([pad, pad, cell - pad, cell - pad], fill=(236, 230, 216), outline=HAIR, width=2)
    for size in (64, 96, 48, 160):  # Apple 彩色 emoji 是位图字体，只认固定尺寸，逐个试
        try:
            f = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", size)
            d.text((cell / 2, cell / 2), "🍚", font=f, anchor="mm", embedded_color=True)
            return im
        except (OSError, ValueError):
            continue
    d.text((cell / 2, cell / 2), "饭", font=_kai(int(cell * 0.32)), anchor="mm", fill=DIM)
    return im


def _grouped() -> list[tuple[str, list[dict]]]:
    """按随园食单章法分帖：默认分类顺序在前，自定义分类按出现顺序缀后；空分类跳过。
    帖内按做过次数降序（拿手菜排前头），同次数按菜名。"""
    stats = storage.recipe_stats()
    recipes = storage.list_recipes()
    cats = list(storage.DEFAULT_CATEGORIES)
    for r in recipes:
        if r["category"] not in cats:
            cats.append(r["category"])
    groups = []
    for c in cats:
        rs = sorted([r for r in recipes if r["category"] == c],
                    key=lambda r: (-stats.get(r["id"], {}).get("times", 0), r["name"]))
        if rs:
            groups.append((c, rs))
    return groups


def _cover(d: ImageDraw.ImageDraw, y: int, title: str, fire_days: int, total: int,
           page: int, pages: int) -> int:
    cx = W // 2
    step, slip_w = 118, 156
    slip_h = len(title) * step + 44
    # 竖排题签（册页贴签的质感：浅色纸条 + 细边）
    d.rounded_rectangle([cx - slip_w // 2, y, cx + slip_w // 2, y + slip_h],
                        radius=6, fill=CARD, outline=HAIR, width=2)
    fk = _kai(92, bold=True)
    for i, ch in enumerate(title):
        d.text((cx, y + 22 + i * step + step // 2), ch, font=fk, anchor="mm", fill=INK)
    # 右侧一列：年月竖排小字，其下一枚朱砂方印「箪」（仿 monthcard 印章画法）
    side_x = cx + slip_w // 2 + 78
    t = date.today()
    fy = _song(27)
    yy = y + 10
    for ch in "".join(CN_DIGIT[int(c)] for c in str(t.year)) + "年" + _cn(t.month) + "月":
        d.text((side_x, yy + 19), ch, font=fy, anchor="mm", fill=DIM)
        yy += 38
    yy += 26
    seal = 92
    d.rounded_rectangle([side_x - seal // 2, yy, side_x + seal // 2, yy + seal], radius=12, fill=RED)
    d.text((side_x, yy + seal // 2 - 2), "箪", font=_font(54), anchor="mm", fill=CARD)

    y += slip_h + 58
    stat = f"开火 {fire_days} 日，得菜 {total} 品" if fire_days else f"新册初立，得菜 {total} 品"
    d.text((cx, y), stat, font=_kai(34), anchor="mm", fill=RED)
    y += 42
    if pages > 1:
        d.text((cx, y + 6), f"卷{_cn(page)} · 共{_cn(pages)}卷", font=_song(25), anchor="mm", fill=DIM)
        y += 44
    return y + 64


def _section_header(d: ImageDraw.ImageDraw, y: int, name: str, count: int | None,
                    color=INK) -> int:
    f = _kai(40, bold=True)
    d.text((90, y + 22), name, font=f, anchor="lm", fill=color)
    x = 90 + f.getlength(name) + 18
    if count is not None:
        fc = _kai(24)
        cnt = f"{_cn(count)} 品"
        d.text((x, y + 27), cnt, font=fc, anchor="lm", fill=DIM)
        x += fc.getlength(cnt) + 24
    d.line([(x, y + 24), (W - 90, y + 24)], fill=RED, width=2)
    return y + 78


def _dish_row(img: Image.Image, d: ImageDraw.ImageDraw, y: int, r: dict, st: dict) -> int:
    cell = 120
    thumb = None
    data = photostore.fetch(r.get("cover") or "")  # 本地 /photos/ 或 COS https 都由 fetch 兜住
    if data:
        try:
            thumb = Image.open(io.BytesIO(data)).convert("RGBA").resize((cell, cell), Image.LANCZOS)
        except Exception:  # 坏图/半截下载：占位，别让整张图 500
            thumb = None
    if thumb is None:
        thumb = _placeholder(cell)
    thumb = _rounded(thumb, 22)
    img.paste(thumb, (90, y + 10), thumb)

    fn, f = _kai(41), _song(25)
    d.text((248, y + 40), r["name"], font=fn, anchor="lm", fill=INK)
    # 每餐 kcal 小注靠右如标价；菜名与它之间一条细虚线引开（食单「菜名……价」式引线）
    kcal = nutrition.per_serving_kcal(r)
    k_txt = (f"≈{kcal} kcal" + ("/餐" if (r.get("servings") or 1) > 1 else "")) \
        if kcal is not None else ""
    if k_txt:
        d.text((W - 90, y + 46), k_txt, font=f, anchor="rm", fill=DIM)
    lx = 248 + fn.getlength(r["name"]) + 28
    lend = W - 96 - (f.getlength(k_txt) + 26 if k_txt else 6)
    while lx < lend:
        d.line([(lx, y + 48), (lx + 7, y + 48)], fill=HAIR, width=2)
        lx += 16
    # 档案戳一行：做过 N 次 · 红圈评分（实心=分数）
    fy, x = y + 98, 250
    times = st.get("times", 0)
    t_txt = f"做过 {times} 次" if times else "还没做过"
    d.text((x, fy), t_txt, font=f, anchor="lm", fill=DIM)
    x += f.getlength(t_txt) + 30
    rating = st.get("rating")
    if rating:
        n = max(1, min(5, round(rating)))
        for i in range(5):
            ccx = x + 9 + i * 27
            if i < n:
                d.ellipse([ccx - 8, fy - 8, ccx + 8, fy + 8], fill=RED)
            else:
                d.ellipse([ccx - 8, fy - 8, ccx + 8, fy + 8], outline=RED, width=2)
    return y + 154


def _orders_block(d: ImageDraw.ImageDraw, y: int, orders: list[dict]) -> int:
    y = _section_header(d, y + 6, "候膳", None, color=RED)
    f = _kai(30)
    for o in orders:
        who = str(o.get("from") or "神秘食客")
        for it in o.get("items", []):
            note = f"（{it['note']}）" if it.get("note") else ""
            d.text((110, y + 16), f"{who} 点：{it.get('name', '')}{note}，候", font=f,
                   anchor="lm", fill=RED)
            y += 50
    return y + 14


def _footer(d: ImageDraw.ImageDraw, y: int) -> int:
    y += 66
    cx, s = W // 2, 58
    d.rounded_rectangle([cx - s // 2, y, cx + s // 2, y + s], radius=9, fill=RED)
    d.text((cx, y + s // 2 - 2), "箪", font=_font(34), anchor="mm", fill=CARD)
    d.text((cx, y + s + 34), "一箪食", font=_kai(28), anchor="mm", fill=DIM)
    return y + s + 34 + 64


def render(style: str, page: int = 1) -> tuple[bytes, int]:
    """→ (png 字节, 总页数)。无菜谱抛 ValueError，页码越界抛 LookupError。"""
    title = STYLES.get(style, STYLES["family"])
    groups = _grouped()
    total = sum(len(rs) for _, rs in groups)
    if total == 0:
        raise ValueError("食单还空着")
    pages = 1 if total <= DIRECT_MAX else -(-total // PAGE_SIZE)
    if not 1 <= page <= pages:
        raise LookupError(f"没有这一页（共 {pages} 页）")
    if pages > 1:  # 分页：拉平后按页切，再按分类重组（跨页的分类两页各出一次小标）
        flat = [(c, r) for c, rs in groups for r in rs]
        part = flat[(page - 1) * PAGE_SIZE: page * PAGE_SIZE]
        groups = []
        for c, r in part:
            if groups and groups[-1][0] == c:
                groups[-1][1].append(r)
            else:
                groups.append((c, [r]))

    stats = storage.recipe_stats()
    fire_days = len({str(m["date"]) for m in storage.list_meals() if m.get("date")})
    orders = [o for o in (storage.read_doc("orders") or [])
              if not o.get("done") and o.get("items")] if page == pages else []
    n_lines = sum(len(o["items"]) for o in orders)

    est = (900 + sum(110 + 154 * len(rs) for _, rs in groups)
           + (140 + 50 * n_lines if orders else 0) + 500)
    img = Image.new("RGB", (W, est), PAPER)
    d = ImageDraw.Draw(img)

    y = _cover(d, 88, title, fire_days, total, page, pages)
    for c, rs in groups:
        y = _section_header(d, y, c, len(rs))
        for r in rs:
            y = _dish_row(img, d, y, r, stats.get(r["id"], {}))
        y += 26
    if orders:
        y = _orders_block(d, y, orders)
    y = _footer(d, y)

    img = img.crop((0, 0, W, y))
    d = ImageDraw.Draw(img)  # 文武边（先裁出最终高度再画框，才贴得住四边）
    d.rectangle([28, 28, W - 29, y - 29], outline=FRAME, width=3)
    d.rectangle([40, 40, W - 41, y - 41], outline=HAIR, width=1)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue(), pages
