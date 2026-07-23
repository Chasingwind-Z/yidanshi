"""小红书宣发首图生成器（本地工具，不部署）。

「实物感」路线（docs/competitor-absorption.md 宣发图模式）：宣纸底 + 朱砂大字
关系叙事标题 + 产品自产图（教程卡/长图/月结卡）斜放投影如一张纸落在桌上 +
小印落款。3:4 幅面（1290×1720），XHS 首图标准。不放二维码/链接（策略：不引流）。

用法：
  .venv/bin/python scripts/xhs_cover.py \
      --title "一个人住|我给来家吃饭的朋友|做了个点菜小程序" \
      --card /path/to/教程卡.png [--sub "副题一句"] [-o ~/Desktop/cover.png]

  --title  用 | 手动断行（推荐，节奏自己定）；不含 | 时按宽度自动折行
  --card   教程卡/长图 PNG（会取顶部最好看的一截，斜放+投影）；可省略=纯字封面
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.menuposter import _kai, _song  # noqa: E402 —— 与产品同一套字体链
from server.monthcard import _font  # noqa: E402

W, H = 1290, 1720                      # 3:4，小红书首图甜区
PAPER = (244, 239, 227)
INK = (47, 42, 34)
DIM = (141, 130, 113)
RED = (176, 57, 43)
CARD_BG = (253, 250, 243)
M = 96                                 # 边距


def _vignette(img: Image.Image, strength: int = 26) -> Image.Image:
    """四角轻微压暗：一点"桌面打光"的实物感，别过头变旧照片。"""
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([-W * 0.35, -H * 0.35, W * 1.35, H * 1.35], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(180))
    dark = Image.new("RGB", (W, H), tuple(max(0, c - strength) for c in PAPER))
    return Image.composite(img, dark, mask)


def _wrap_title(title: str, font, width: float) -> list[str]:
    if "|" in title:
        return [ln for ln in title.split("|") if ln.strip()]
    lines, cur = [], ""
    for ch in title:
        if cur and font.getlength(cur + ch) > width:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def _card_piece(path: Path) -> Image.Image:
    """取卡片顶部最好看的一截（约 4:5），缩放到画布宽的 82%，白纸描边。"""
    im = Image.open(path).convert("RGB")
    keep_h = min(im.height, round(im.width * 1.25))
    im = im.crop((0, 0, im.width, keep_h))
    tw = round(W * 0.82)
    im = im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS)
    # 白纸边（像一张打印出来的卡）：四周 10px 纸边
    pad = 10
    sheet = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), CARD_BG)
    sheet.paste(im, (pad, pad))
    return sheet


def _place_tilted(canvas: Image.Image, piece: Image.Image, top: int, angle: float = -5.5) -> None:
    """斜放 + 柔影，底边探出画布（"下面还有"的翻页感）。"""
    rot = piece.convert("RGBA").rotate(angle, expand=True, resample=Image.BICUBIC)
    x = (W - rot.width) // 2
    # 影子：轮廓 → 高斯模糊 → 右下偏移
    sil = Image.new("RGBA", rot.size, (0, 0, 0, 0))
    sil.paste(Image.new("RGBA", rot.size, (30, 22, 10, 130)), mask=rot.split()[-1])
    shadow = sil.filter(ImageFilter.GaussianBlur(20))
    canvas.paste(shadow, (x + 18, top + 26), shadow)
    canvas.paste(rot, (x, top), rot)


def render(title: str, card: Path | None, sub: str | None) -> Image.Image:
    img = Image.new("RGB", (W, H), PAPER)
    img = _vignette(img)
    d = ImageDraw.Draw(img)

    # ---- 标题：朱砂楷体大字，左对齐（关系叙事是主角） ----
    ft = _kai(108, bold=True)
    lines = _wrap_title(title, ft, W - 2 * M)
    y = 128
    for ln in lines:
        d.text((M, y), ln, font=ft, anchor="lt", fill=RED)
        y += 138
    if sub:
        y += 10
        d.text((M, y), sub, font=_kai(44), anchor="lt", fill=DIM)
        y += 72

    # ---- 卡片斜放（无卡则给一枚居中大印，纯字封面也立得住） ----
    if card is not None:
        _place_tilted(img, _card_piece(card), top=y + 56)
        d = ImageDraw.Draw(img)  # 贴图后重新拿画笔
    else:
        s = 220
        cx, cy = W // 2, y + (H - y) // 2 - 60
        d.rounded_rectangle([cx - s // 2, cy - s // 2, cx + s // 2, cy + s // 2],
                            radius=24, fill=RED)
        d.text((cx, cy - 4), "箪", font=_font(130), anchor="mm", fill=CARD_BG)

    # ---- 落款：只有纯字封面才落（有卡时卡自带印，角落再盖会和卡片文字打架） ----
    if card is None:
        s = 64
        fy = H - 118
        d.rounded_rectangle([M, fy, M + s, fy + s], radius=10, fill=RED)
        d.text((M + s // 2, fy + s // 2 - 2), "箪", font=_font(38), anchor="mm", fill=CARD_BG)
        d.text((M + s + 22, fy + s // 2), "一箪食", font=_kai(34), anchor="lm", fill=DIM)
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description="小红书宣发首图（3:4 实物感）")
    ap.add_argument("--title", required=True, help="标题，| 手动断行")
    ap.add_argument("--card", type=Path, default=None, help="教程卡/长图 PNG 路径")
    ap.add_argument("--sub", default=None, help="副题一句（可省）")
    ap.add_argument("-o", "--out", type=Path,
                    default=Path.home() / "Desktop" / "xhs-cover.png")
    a = ap.parse_args()
    img = render(a.title, a.card, a.sub)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(a.out, "PNG")
    print(f"已生成 {a.out}（{img.width}×{img.height}）")


if __name__ == "__main__":
    main()
