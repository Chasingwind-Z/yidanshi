"""抠图美化管线：原图 → rembg 抠出碗盘（透明 PNG）→ 合成深色底菜卡。

模型默认 isnet-general-use（约 180MB，首次运行自动下载）；
追求更高质量可设环境变量 YIDANSHI_MODEL=birefnet-general（约 930MB）。
"""
from __future__ import annotations

import io
import os
from functools import lru_cache

from PIL import Image, ImageFilter

MODEL = os.environ.get("YIDANSHI_MODEL", "isnet-general-use")
CARD_SIZE = 1024
CARD_BG = (13, 13, 13, 255)  # Taste 同款近黑底
SUBJECT_RATIO = 0.78         # 主体占卡片宽度比例


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

    # 投影：主体 alpha 放大模糊，向下偏移
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = subject.getchannel("A").point(lambda a: int(a * 0.55))
    shadow.paste((0, 0, 0, 255), (x, y + int(size * 0.03)), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.03))

    card.alpha_composite(shadow)
    card.alpha_composite(subject, (x, y))
    return card


def process(raw: bytes, already_cut: bool = False) -> tuple[bytes, bytes]:
    """返回 (透明PNG bytes, 菜卡PNG bytes)。already_cut=True 表示上传的已是透明抠图（如 iPhone 长按抠图导出）。"""
    if already_cut:
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        bbox = img.getbbox()
        cut = img.crop(bbox) if bbox else img
    else:
        cut = remove_bg(raw)

    def png(im: Image.Image) -> bytes:
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()

    return png(cut), png(make_card(cut))
