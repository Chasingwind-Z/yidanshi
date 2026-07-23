"""插画教程卡：单道菜谱 → 一张竖版可保存分享的教程长卡（Pillow 合成，纸底+朱砂+楷体）。

版式自上而下：卡头（菜名楷体大字 + 分类小字 + 朱砂方印「箪」，有 servings 时右上
「这锅够吃 N 餐」）→ 封面圆角大图（有则放，无则跳过）→ 食材网格（每行四格：插画
图标或浅色圆底首字 + 名字 + 用量小字）→ 做法逐步（朱砂圈号①②③ + 文字自动换行 +
步骤插画圆角小图）→ 小贴士（虚线框，有才出）→ 朱批（历次记录的备注，朱砂楷体，
有才出）→ 落款（小印 + 一箪食）。高度按内容自适应；与 menuposter/monthcard 同一
视觉语言；不放二维码/链接/水印。
"""
from __future__ import annotations

import io
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont

from . import photostore, storage
from .menuposter import (CARD, DIM, FRAME, HAIR, INK, PAPER, RED, _cn, _font,
                         _kai, _rounded, _song)

W = 1080
M = 80                # 左右边距
CW = W - 2 * M        # 内容宽


_NO_HEAD = "，。、；：！？）】」』”’…—%℃"  # 避头点：这些不站行首，宁可挤在上一行行尾


def _wrap(text: str, font: ImageFont.FreeTypeFont, width: float) -> list[str]:
    """逐字换行（中文为主，够用；空文本也回一行免得版式塌）。"""
    lines, cur = [], ""
    for ch in str(text):
        if ch == "\n":
            lines.append(cur)
            cur = ""
        elif cur and ch not in _NO_HEAD and font.getlength(cur + ch) > width:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    lines.append(cur)
    return [ln for ln in lines if ln] or [""]


def _load(ref: str) -> Image.Image | None:
    """按字段值拉图（本地路径/COS https 都由 photostore.fetch 兜住），坏图返回 None。
    COS 的食材图标 URL 按食材名命名（非 ASCII），urllib 只吃 ASCII——先 percent-encode。"""
    if ref and ref.startswith(("http://", "https://")):
        ref = quote(ref, safe=":/?&=%")
    data = photostore.fetch(ref or "")
    if not data:
        return None
    try:
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:  # 半截下载/非图片：当没有，绝不让整卡 500
        return None


def _fit(im: Image.Image, width: int, max_h: int) -> Image.Image:
    """等宽缩放，过高则居中裁掉上下（封面用）。"""
    h = max(1, round(im.height * width / im.width))
    im = im.resize((width, h), Image.LANCZOS)
    if h > max_h:
        top = (h - max_h) // 2
        im = im.crop((0, top, width, top + max_h))
    return im


def _seal(d: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    """朱砂方印「箪」（与 menuposter 封面印同款画法）。"""
    d.rounded_rectangle([x, y, x + size, y + size], radius=max(8, size // 8), fill=RED)
    d.text((x + size / 2, y + size / 2 - 2), "箪", font=_font(int(size * 0.58)),
           anchor="mm", fill=CARD)


def _section(d: ImageDraw.ImageDraw, y: int, name: str, color=INK) -> int:
    f = _kai(38, bold=True)
    d.text((M, y + 20), name, font=f, anchor="lm", fill=color)
    d.line([(M + f.getlength(name) + 20, y + 22), (W - M, y + 22)], fill=RED, width=2)
    return y + 74


def _dashed_rect(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int],
                 color, dash: int = 9, gap: int = 7) -> None:
    x0, y0, x1, y1 = box
    x = x0
    while x < x1:
        d.line([(x, y0), (min(x + dash, x1), y0)], fill=color, width=2)
        d.line([(x, y1), (min(x + dash, x1), y1)], fill=color, width=2)
        x += dash + gap
    y = y0
    while y < y1:
        d.line([(x0, y), (x0, min(y + dash, y1))], fill=color, width=2)
        d.line([(x1, y), (x1, min(y + dash, y1))], fill=color, width=2)
        y += dash + gap


def _step_no(d: ImageDraw.ImageDraw, x: int, cy: int, n: int) -> None:
    """朱砂步骤号：①②③…（宋体圈号字形，>20 步兜底画圈写数）。"""
    if 1 <= n <= 20:
        d.text((x, cy), chr(0x2460 + n - 1), font=_song(46), anchor="lm", fill=RED)
    else:
        d.ellipse([x, cy - 21, x + 42, cy + 21], outline=RED, width=3)
        d.text((x + 21, cy), str(n), font=_song(26), anchor="mm", fill=RED)


def _ing_icon(icon: Image.Image | None, name: str, cell: int) -> Image.Image:
    """食材图标：插画有就用（圆形裁切），没有画浅色圆底 + 首字。"""
    if icon is not None:
        return _rounded(icon.resize((cell, cell), Image.LANCZOS), cell // 2)
    im = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([2, 2, cell - 2, cell - 2], fill=(236, 230, 216), outline=HAIR, width=2)
    d.text((cell / 2, cell / 2), (name or "？")[0], font=_kai(int(cell * 0.42)),
           anchor="mm", fill=DIM)
    return im


def render(rid: str) -> bytes:
    """→ png 字节。菜谱不存在抛 LookupError。"""
    r = storage.get_recipe(rid)
    if r is None:
        raise LookupError("没有这道菜")

    # 朱批：历次记录里带备注的（与 /api/recipes/{rid} 同口径，最近 5 条）
    notes = sorted([(str(m["date"]), str(m["note"])) for m in storage.list_meals()
                    if m.get("recipe_id") == rid and m.get("note")], reverse=True)[:5]

    illust = r.get("illust") or {}
    ings, steps, tips = r["ingredients"], r["steps"], r["tips"]

    # ---- 预取图片（本地直读 / COS urllib，失败当没有）----
    cover = _load(r.get("cover"))
    if cover is not None:
        cover = _rounded(_fit(cover, CW, 640), 26)
    ing_icons = [_load(u) for u in (illust.get("ingredients") or [])]
    ing_icons += [None] * (len(ings) - len(ing_icons))
    step_imgs = []
    for i in range(len(steps)):
        urls = illust.get("steps") or []
        im = _load(urls[i]) if i < len(urls) else None
        if im is not None:
            sw = 420
            im = _rounded(im.resize((sw, max(1, round(im.height * sw / im.width))),
                                    Image.LANCZOS), 16)
        step_imgs.append(im)

    # ---- 字体与量版 ----
    f_step = _song(33)
    f_tip = _song(29)
    f_note = _kai(29)
    step_w = CW - 66                      # 圈号占位后的文字宽
    name_lines = _wrap(r["name"], _kai(72, bold=True), CW - 96 - 40)

    est = 120 + len(name_lines) * 92 + 130
    if cover is not None:
        est += cover.height + 44
    if ings:
        est += 74 + -(-len(ings) // 4) * 252 + 10
    if steps:
        est += 74
        for i, s in enumerate(steps):
            est += len(_wrap(s, f_step, step_w)) * 50 + 30
            if step_imgs[i] is not None:
                est += step_imgs[i].height + 20
    if tips:
        est += 90 + sum(len(_wrap(t, f_tip, CW - 92)) for t in tips) * 46 + 60
    if notes:
        est += 74 + sum(len(_wrap(f"某月某日：{n}", f_note, CW - 20)) for _, n in notes) * 48 + 20
    est += 260 + 200  # 落款 + 富余（最后按实际 y 裁掉）

    img = Image.new("RGB", (W, est), PAPER)
    d = ImageDraw.Draw(img)

    # ---- 卡头 ----
    y = 96
    seal_size = 96
    _seal(d, W - M - seal_size, y - 6, seal_size)
    fk = _kai(72, bold=True)
    for ln in name_lines:
        d.text((M, y + 40), ln, font=fk, anchor="lm", fill=INK)
        y += 92
    sub = " · ".join(x for x in (
        r.get("category"), r.get("difficulty"),
        f"{r['minutes']} 分钟" if r.get("minutes") else "") if x)
    if sub:
        d.text((M, y + 10), sub, font=_song(28), anchor="lm", fill=DIM)
    servings = r.get("servings") or 1
    if servings > 1:
        d.text((W - M, y + 10), f"这锅够吃 {servings} 餐", font=_kai(27), anchor="rm", fill=RED)
    y += 66

    # ---- 封面 ----
    if cover is not None:
        img.paste(cover, (M, y), cover)
        y += cover.height + 44

    # ---- 食材 ----
    if ings:
        y = _section(d, y, "食材")
        cell, cw4 = 148, CW // 4
        fn, fa = _kai(29), _song(23)
        for i, ing in enumerate(ings):
            cx = M + (i % 4) * cw4 + cw4 // 2
            ry = y + (i // 4) * 252
            icon = _ing_icon(ing_icons[i], ing["name"], cell)
            img.paste(icon, (cx - cell // 2, ry), icon)
            d.text((cx, ry + cell + 22), ing["name"][:6], font=fn, anchor="mm", fill=INK)
            if ing.get("amount"):
                amt = ing["amount"]
                while fa.getlength(amt) > cw4 - 12 and len(amt) > 1:
                    amt = amt[:-1]
                d.text((cx, ry + cell + 56), amt, font=fa, anchor="mm", fill=DIM)
        y += -(-len(ings) // 4) * 252 + 10

    # ---- 做法 ----
    if steps:
        y = _section(d, y, "做法")
        for i, s in enumerate(steps):
            lines = _wrap(s, f_step, step_w)
            _step_no(d, M, y + 24, i + 1)
            for ln in lines:
                d.text((M + 66, y + 24), ln, font=f_step, anchor="lm", fill=INK)
                y += 50
            if step_imgs[i] is not None:
                im = step_imgs[i]
                img.paste(im, (M + 66, y + 4), im)
                y += im.height + 12
            y += 28

    # ---- 小贴士 ----
    if tips:
        y += 16
        top = y
        y += 30
        ft = _kai(31, bold=True)
        d.text((M + 26, y + 16), "小贴士", font=ft, anchor="lm", fill=INK)
        y += 56
        for t in tips:
            for j, ln in enumerate(_wrap(t, f_tip, CW - 92)):
                d.text((M + 26, y + 14), ("· " if j == 0 else "  ") + ln,
                       font=f_tip, anchor="lm", fill=(87, 80, 63))
                y += 46
        y += 24
        _dashed_rect(d, (M, top, W - M, y), FRAME)
        y += 30

    # ---- 朱批 ----
    if notes:
        y = _section(d, y, "朱批", color=RED)
        for date_s, note in notes:
            try:
                mo, day = int(date_s[5:7]), int(date_s[8:10])
                when = f"{_cn(mo)}月{_cn(day)}日"
            except (ValueError, IndexError):
                when = date_s
            for ln in _wrap(f"{when}：{note}", f_note, CW - 20):
                d.text((M + 10, y + 14), ln, font=f_note, anchor="lm", fill=RED)
                y += 48
            y += 6
        y += 14

    # ---- 落款（同 menuposter：小印 + 一箪食，无二维码）----
    y += 56
    cx, s = W // 2, 58
    d.rounded_rectangle([cx - s // 2, y, cx + s // 2, y + s], radius=9, fill=RED)
    d.text((cx, y + s // 2 - 2), "箪", font=_font(34), anchor="mm", fill=CARD)
    d.text((cx, y + s + 34), "一箪食", font=_kai(28), anchor="mm", fill=DIM)
    y += s + 34 + 64

    img = img.crop((0, 0, W, y))
    d = ImageDraw.Draw(img)  # 文武边（先裁出最终高度再画框，才贴得住四边）
    d.rectangle([26, 26, W - 27, y - 27], outline=FRAME, width=3)
    d.rectangle([38, 38, W - 39, y - 39], outline=HAIR, width=1)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
