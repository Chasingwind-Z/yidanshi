"""阿里云 SegmentFood 抠图：云镜像不装 rembg/onnxruntime 时的替代通道。

SDK（alibabacloud_imageseg20191230）懒加载；ALIYUN_AK_ID/ALIYUN_AK_SECRET 未配
或库缺失 → available() False、cut() None，调用方降级圆框直裁。
"""
from __future__ import annotations

import io
import os
import urllib.request

_ENDPOINT = os.environ.get("ALIYUN_IMAGESEG_ENDPOINT", "imageseg.cn-shanghai.aliyuncs.com")
_MAX_EDGE = 1600  # 见 _prepare()：接口硬拒 >2000px，1600 留足余量且实测不掉质量


def _prepare(raw: bytes) -> bytes:
    """送云端前的入口归一：EXIF 摆正 + 长边降到 1600（JPEG q88）。

    这里不降采样是个必现故障：SegmentFood 拒收任一边 >2000px 的图，直接返回
    InvalidFile.Resolution（「更换分辨率更小的图像（低于2000*2000）」）。而调用方送进来的是
    原图或 cutout._crop_region 的输出，都没降过采样——手机原图（实测 4032×3024）100% 失败，
    被 cut() 的 except 吞掉后静默掉到「圆框直裁」兜底，云端抠图从未真正生效。
    同一张图降到 1600 后同账号同接口立刻返回 mask。
    """
    from PIL import Image, ImageOps

    try:
        src = Image.open(io.BytesIO(raw))
        orient = (src.getexif() or {}).get(274, 1)  # EXIF Orientation：1 表示无需摆正
        img = ImageOps.exif_transpose(src).convert("RGB")
    except Exception:
        return raw  # 读不出来就原样送，让接口自己去报错
    before = img.size
    if max(before) <= _MAX_EDGE and orient in (0, 1):
        return raw  # 已经够小且无 EXIF 转向：原样送，省一次重编码
    img.thumbnail((_MAX_EDGE, _MAX_EDGE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    print(f"[segfood] 送图降采样 {before[0]}×{before[1]} → {img.width}×{img.height}", flush=True)
    return buf.getvalue()


def available() -> bool:
    if not (os.environ.get("ALIYUN_AK_ID", "").strip() and os.environ.get("ALIYUN_AK_SECRET", "").strip()):
        return False
    try:
        import alibabacloud_imageseg20191230  # noqa: F401
        return True
    except Exception:
        return False


def cut(raw: bytes):
    """原图 bytes → 透明背景 RGBA PIL Image（裁到主体外接框）。送图前先过 _prepare() 归一。
    未配置/库缺失/API 失败一律返回 None（不抛），由调用方降级。"""
    if not available():
        return None
    try:
        from alibabacloud_imageseg20191230.client import Client
        from alibabacloud_imageseg20191230.models import SegmentFoodAdvanceRequest
        from alibabacloud_tea_openapi.models import Config
        from alibabacloud_tea_util.models import RuntimeOptions
        from PIL import Image

        client = Client(Config(access_key_id=os.environ["ALIYUN_AK_ID"].strip(),
                               access_key_secret=os.environ["ALIYUN_AK_SECRET"].strip(),
                               endpoint=_ENDPOINT))
        resp = client.segment_food_advance(
            SegmentFoodAdvanceRequest(image_urlobject=io.BytesIO(_prepare(raw))), RuntimeOptions())
        url = resp.body.data.image_url  # 结果是带透明通道的 PNG 临时链接
        with urllib.request.urlopen(url, timeout=20) as r:
            png = r.read()
        img = Image.open(io.BytesIO(png)).convert("RGBA")
        bbox = img.getbbox()
        return img.crop(bbox) if bbox else img
    except Exception:
        return None
