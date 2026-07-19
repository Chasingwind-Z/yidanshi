"""抠图美化管线：原图 → rembg 抠出碗盘（透明 PNG）→ 合成深色底菜卡。

模型默认 isnet-general-use（约 180MB，首次运行自动下载）；
追求更高质量可设环境变量 YIDANSHI_MODEL=birefnet-general（约 930MB）。
"""
from __future__ import annotations

import io
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageFilter

MODEL = os.environ.get("YIDANSHI_MODEL", "isnet-general-use")
CARD_SIZE = 1024
CARD_BG = (244, 239, 227, 255)  # 暖米白宣纸底（与前端 --bg 一致），盘子落在纸上
SUBJECT_RATIO = 0.78         # 主体占卡片宽度比例
ASSETS = Path(__file__).parent / "assets"
# 餐具库：摄影质感素材（同一棚拍光线家族）→ (文件, 食物占卡片宽度比例)
TABLEWARE = {
    "plate": ("plate-photo.png", 0.56),    # 平盘：小炒/默认
    "bowl": ("bowl-photo.png", 0.42),      # 深碗：饭粥/面点/羹汤
    "saucer": ("saucer-photo.png", 0.40),  # 浅盘：甜点
}
CATEGORY_TABLEWARE = {"饭粥": "bowl", "面点": "bowl", "羹汤": "bowl", "甜点": "saucer"}


def match_tableware(category: str) -> str:
    return CATEGORY_TABLEWARE.get(category, "plate")


@lru_cache(maxsize=1)
def _session():
    from rembg import new_session

    return new_session(MODEL)


def remove_bg(raw: bytes) -> Image.Image:
    """原图 → 透明背景 RGBA，裁剪到主体外接框。"""
    from rembg import remove

    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    img.thumbnail((2048, 2048))  # 控制推理与产物体积
    cut = remove(img, session=_session(), post_process_mask=True)
    bbox = cut.getbbox()
    return cut.crop(bbox) if bbox else cut


def make_card(cut: Image.Image, size: int = CARD_SIZE) -> Image.Image:
    """透明 PNG → 深色底 + 居中 + 柔和投影的方形菜卡。"""
    card = Image.new("RGBA", (size, size), CARD_BG)

    target_w = int(size * SUBJECT_RATIO)
    scale = min(target_w / cut.width, target_w / cut.height)
    subject = cut.resize((max(1, int(cut.width * scale)), max(1, int(cut.height * scale))), Image.LANCZOS)
    x, y = (size - subject.width) // 2, (size - subject.height) // 2

    # 投影：主体 alpha 放大模糊，向下偏移（暖褐柔影，适配纸底）
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = subject.getchannel("A").point(lambda a: int(a * 0.35))
    shadow.paste((82, 62, 36, 255), (x, y + int(size * 0.03)), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.03))

    card.alpha_composite(shadow)
    card.alpha_composite(subject, (x, y))
    return card


@lru_cache(maxsize=8)
def _plate_base(asset: str, size: int = CARD_SIZE) -> Image.Image:
    """餐具素材融进纸底：径向羽化边缘，生成图与页面底色的细微色差不会露出方形接缝。"""
    plate = Image.open(ASSETS / asset).convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    from PIL import ImageDraw

    d = ImageDraw.Draw(mask)
    d.ellipse([size * 0.02, size * 0.02, size * 0.98, size * 0.98], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(size * 0.03))
    card = Image.new("RGBA", (size, size), CARD_BG)
    card.paste(plate, (0, 0), mask)
    return card


def _harmonize(food: Image.Image) -> Image.Image:
    """给照片食物一道轻微暖调和，让它'坐进'柔光盘面（不改变食物本身）。"""
    from PIL import ImageEnhance

    rgb = food.convert("RGB")
    rgb = ImageEnhance.Color(rgb).enhance(1.06)
    rgb = ImageEnhance.Brightness(rgb).enhance(1.03)
    warm = Image.new("RGB", rgb.size, (255, 240, 214))
    rgb = Image.blend(rgb, warm, 0.05)
    out = rgb.convert("RGBA")
    out.putalpha(food.getchannel("A"))
    return out


def make_plate_card(cut: Image.Image, tableware: str = "plate", size: int = CARD_SIZE) -> Image.Image:
    """抠出的食物摆进摄影质感餐具：同为照片媒介，观感统一。tableware ∈ TABLEWARE。"""
    asset, ratio = TABLEWARE.get(tableware, TABLEWARE["plate"])
    card = _plate_base(asset, size).copy()
    cut = _harmonize(cut)

    target = int(size * ratio)
    scale = min(target / cut.width, target / cut.height)
    subject = cut.resize((max(1, int(cut.width * scale)), max(1, int(cut.height * scale))), Image.LANCZOS)
    x, y = (size - subject.width) // 2, (size - subject.height) // 2

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = subject.getchannel("A").point(lambda a: int(a * 0.25))
    shadow.paste((82, 62, 36, 255), (x, y + int(size * 0.015)), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.015))

    card.alpha_composite(shadow)
    card.alpha_composite(subject, (x, y))
    return card


def _crop_to_circle(raw: bytes, cx: float, cy: float, r: float) -> Image.Image:
    """按参考圆（相对坐标：cx/cy 为宽高比例，r 为短边比例）裁出圆形区域，边缘柔化。"""
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    w, h = img.size
    pcx, pcy, pr = cx * w, cy * h, r * min(w, h)
    box = (int(pcx - pr), int(pcy - pr), int(pcx + pr), int(pcy + pr))
    sq = img.crop(box)

    mask = Image.new("L", sq.size, 0)
    from PIL import ImageDraw

    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, sq.width, sq.height], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, sq.width // 300)))
    sq.putalpha(mask)
    return sq


def _crop_region(raw: bytes, cx: float, cy: float, r: float, pad: float = 1.15) -> bytes:
    """裁出参考圆附近的方形区域（略带余量），让抠图模型聚焦主体。"""
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    pcx, pcy, pr = cx * w, cy * h, r * min(w, h) * pad
    box = (max(0, int(pcx - pr)), max(0, int(pcy - pr)), min(w, int(pcx + pr)), min(h, int(pcy + pr)))
    buf = io.BytesIO()
    img.crop(box).save(buf, "JPEG", quality=92)
    return buf.getvalue()


def _png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def process(raw: bytes, already_cut: bool = False) -> tuple[bytes, bytes]:
    """返回 (透明PNG bytes, 菜卡PNG bytes)。already_cut=True 表示上传的已是透明抠图（如 iPhone 长按抠图导出）。"""
    if already_cut:
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        bbox = img.getbbox()
        cut = img.crop(bbox) if bbox else img
    else:
        cut = remove_bg(raw)
    return _png(cut), _png(make_card(cut))


def is_transparent(raw: bytes) -> bool:
    """识别已抠好的透明图（如 iPhone 长按抠图导出）：带 alpha 且四角透明。"""
    try:
        img = Image.open(io.BytesIO(raw))
        if img.mode != "RGBA":
            return False
        a = img.getchannel("A")
        w, h = a.size
        return all(a.getpixel(p) == 0 for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    except Exception:
        return False


def process_modes(raw: bytes, modes: list[str], circle: tuple[float, float, float] | None) -> dict[str, tuple[bytes, bytes]]:
    """按模式产出多份结果：plate=抠出食物摆插画盘（推荐），auto=AI 抠图直出，
    circle=参考圆直接裁（不走模型的兜底）。AI 抠图只跑一次共用；失败时只要 circle 还在就静默降级。"""
    out: dict[str, tuple[bytes, bytes]] = {}
    ai_cut: Image.Image | None = None
    for mode in modes:
        try:
            if mode == "circle":
                if circle is None:
                    continue
                cut = _crop_to_circle(raw, *circle)
                out[mode] = (_png(cut), _png(make_card(cut)))
            else:
                if ai_cut is None:
                    focused = _crop_region(raw, *circle) if circle else raw
                    ai_cut = remove_bg(focused)
                card = make_plate_card(ai_cut) if mode == "plate" else make_card(ai_cut)
                out[mode] = (_png(ai_cut), _png(card))
        except Exception:
            if mode == "circle" or (not out and mode == modes[-1]):
                raise
    return out
