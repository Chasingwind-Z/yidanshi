"""抠图美化管线：原图 → rembg 抠出碗盘（透明 PNG）→ 合成深色底菜卡。

模型默认 birefnet-general（约 930MB，首次运行自动下载到 ~/.u2net/——第一张抠图
会等几分钟，属预期不是卡死；抠图质量显著好于轻量模型）；
想省磁盘/内存可设环境变量 YIDANSHI_MODEL=isnet-general-use 退回轻量模型（约 180MB）。
"""
from __future__ import annotations

import io
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

MODEL = os.environ.get("YIDANSHI_MODEL", "birefnet-general")
CARD_SIZE = 1024
CARD_BG = (244, 239, 227, 255)  # 暖米白宣纸底（与前端 --bg 一致），盘子落在纸上
SUBJECT_RATIO = 0.78         # 主体占卡片宽度比例
ALPHA_FLOOR, ALPHA_CEIL = 40, 215   # 软边 levels：低于 FLOOR 的柔光晕归零，高于 CEIL 视作全不透明
ASSETS = Path(__file__).parent / "assets"
# 餐具库：摄影质感素材（同一棚拍光线家族）→ (文件, 食物占卡片宽度比例)
TABLEWARE = {
    "plate": ("plate-photo.png", 0.58),    # 平盘：小炒/默认
    "bowl": ("bowl-photo.png", 0.54),      # 深碗：饭粥/面点/羹汤
    "saucer": ("saucer-photo.png", 0.46),  # 浅盘：甜点
}
CATEGORY_TABLEWARE = {"饭粥": "bowl", "面点": "bowl", "羹汤": "bowl", "甜点": "saucer"}


def match_tableware(category: str) -> str:
    return CATEGORY_TABLEWARE.get(category, "plate")


@lru_cache(maxsize=1)
def _have_rembg() -> bool:
    try:
        import rembg  # noqa: F401
        return True
    except Exception:
        return False


@lru_cache(maxsize=1)
def _session():
    from rembg import new_session

    return new_session(MODEL)


def _open(raw: bytes) -> Image.Image:
    """本文件唯一的读图入口：读进来立刻按 EXIF 摆正，全链路都在「已摆正」的坐标系里。

    不这么做会出真 bug：rembg 的 remove() 内部最后一步是 exif_transpose，而本文件其余部分
    （圆框换算、_crop_region/_crop_to_circle）按 PIL 原始像素解释，两边坐标系不一致——
    实测 orientation=6 的 iPhone 竖拍（4032×3024）走 circle=None 那条路，抠图直接转了 90°。
    exif_transpose 同时会清掉 orientation 标签，rembg 后面那次就成了空操作，不会转两回。
    前端圆框也是在浏览器已按 EXIF 摆正的预览图上取的，与此一致（此前非居中圆会落错位置）。
    """
    return ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))


def _soft_alpha(alpha: Image.Image) -> Image.Image:
    """去碎斑 + 平滑，但**不二值化**——保住 256 级软边。

    rembg 的 post_process_mask 是「开运算 → 高斯 → 127 硬阈值」，坏在最后一步：alpha 只剩
    0/255，3× 放大就是台阶锯齿，轮廓还整体内缩一圈（外层米粒被削掉）。这里照抄它的前两步
    （scipy/scikit-image 都是 rembg 自带依赖，本函数也只在 rembg 可用时才会跑到，不新增依赖），
    再用一段 levels 把低 alpha 的柔光晕（白盘反光那一圈）压到 0，中间保持线性过渡。
    """
    import numpy as np
    from scipy.ndimage import gaussian_filter
    from skimage.morphology import disk, opening

    a = opening(np.asarray(alpha), disk(1))
    a = gaussian_filter(a.astype(np.float32), sigma=2)
    a = np.clip((a - ALPHA_FLOOR) / (ALPHA_CEIL - ALPHA_FLOOR), 0, 1) * 255
    return Image.fromarray(a.astype(np.uint8), "L")


def remove_bg(raw: bytes) -> Image.Image:
    """原图 → 透明背景 RGBA，裁剪到主体外接框。"""
    from rembg import remove

    img = _open(raw).convert("RGBA")
    img.thumbnail((2048, 2048))  # 控制推理与产物体积
    cut = remove(img, session=_session(), post_process_mask=False)  # 二值化换成 _soft_alpha
    cut.putalpha(_soft_alpha(cut.getchannel("A")))
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
    img = _open(raw).convert("RGBA")
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
    img = _open(raw).convert("RGB")
    w, h = img.size
    pcx, pcy, pr = cx * w, cy * h, r * min(w, h) * pad
    box = (max(0, int(pcx - pr)), max(0, int(pcy - pr)), min(w, int(pcx + pr)), min(h, int(pcy + pr)))
    buf = io.BytesIO()
    img.crop(box).save(buf, "JPEG", quality=92)
    return buf.getvalue()


def _square_crop(im: Image.Image, circle: tuple[float, float, float] | None) -> Image.Image:
    """按取景圆的圆心居中方裁（没圆则画面居中）——留原图当封面用。"""
    w, h = im.size
    side = min(w, h)
    ccx, ccy = (int(circle[0] * w), int(circle[1] * h)) if circle else (w // 2, h // 2)
    left = max(0, min(w - side, ccx - side // 2))
    top = max(0, min(h - side, ccy - side // 2))
    return im.crop((left, top, left + side, top + side))


def make_photo_card(raw: bytes, circle: tuple[float, float, float] | None = None,
                    size: int = CARD_SIZE) -> Image.Image:
    """留原图：EXIF 摆正 → 方裁 → 圆角落纸底。不抠图不合成——想要真实那张照片当封面时用。"""
    from PIL import ImageDraw
    sq = _square_crop(_open(raw).convert("RGB"), circle).resize((size, size), Image.LANCZOS)
    card = Image.new("RGBA", (size, size), CARD_BG)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=int(size * 0.06), fill=255)
    card.paste(sq, (0, 0), mask)
    return card


def _png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def process(raw: bytes, already_cut: bool = False) -> tuple[bytes, bytes]:
    """返回 (透明PNG bytes, 菜卡PNG bytes)。already_cut=True 表示上传的已是透明抠图（如 iPhone 长按抠图导出）。"""
    if already_cut:
        img = _open(raw).convert("RGBA")
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


def process_modes(raw: bytes, modes: list[str], circle: tuple[float, float, float] | None,
                  precut: Image.Image | None = None,
                  precut_with_tableware: bool = False) -> dict[str, tuple[bytes, bytes]]:
    """按模式产出多份结果：plate=抠出食物摆插画盘（推荐），auto=AI 抠图直出，
    circle=参考圆直接裁（不走模型的兜底）。AI 抠图只跑一次共用；失败时只要 circle 还在就静默降级。
    precut：外部通道（如云端 segfood）已抠好的透明主体，传入则不再跑 rembg，摆盘合成同一套。
    precut_with_tableware：这份 precut 里连餐具一起抠了（阿里云 SegmentFood 是菜品分割，
    实测 4 张样本里的长白盘/青花碗/花瓷盘全部保留）。这种主体再走 make_plate_card 就是
    「盘上摞盘 / 碗上摞盘」，穿帮很明显，所以 plate 模式改用不含盘子的纸底版式 make_card；
    auto 模式本来就是纸底直出，连餐具反而更完整，直接采信。仅在 precut 非空时有意义。"""
    out: dict[str, tuple[bytes, bytes]] = {}
    ai_cut: Image.Image | None = precut
    for mode in modes:
        try:
            if mode == "photo":  # 留原图：不抠不合成，方裁圆角落纸底（不依赖 rembg，云端也能出）
                card = make_photo_card(raw, circle)
                out[mode] = (_png(card), _png(card))
            elif mode == "circle":
                if circle is None:
                    continue
                cut = _crop_to_circle(raw, *circle)
                out[mode] = (_png(cut), _png(make_card(cut)))
            else:
                if ai_cut is None:
                    focused = _crop_region(raw, *circle) if circle else raw
                    ai_cut = remove_bg(focused)
                on_plate = mode == "plate" and not (ai_cut is precut and precut_with_tableware)
                card = make_plate_card(ai_cut) if on_plate else make_card(ai_cut)
                out[mode] = (_png(ai_cut), _png(card))
        except Exception:
            if mode == "circle" or (not out and mode == modes[-1]):
                raise
    return out
