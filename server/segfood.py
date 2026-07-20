"""阿里云 SegmentFood 抠图：云镜像不装 rembg/onnxruntime 时的替代通道。

SDK（alibabacloud_imageseg20191230）懒加载；ALIYUN_AK_ID/ALIYUN_AK_SECRET 未配
或库缺失 → available() False、cut() None，调用方降级圆框直裁。
"""
from __future__ import annotations

import io
import os
import urllib.request

_ENDPOINT = os.environ.get("ALIYUN_IMAGESEG_ENDPOINT", "imageseg.cn-shanghai.aliyuncs.com")


def available() -> bool:
    if not (os.environ.get("ALIYUN_AK_ID", "").strip() and os.environ.get("ALIYUN_AK_SECRET", "").strip()):
        return False
    try:
        import alibabacloud_imageseg20191230  # noqa: F401
        return True
    except Exception:
        return False


def cut(raw: bytes):
    """原图 bytes → 透明背景 RGBA PIL Image（裁到主体外接框）。
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
            SegmentFoodAdvanceRequest(image_urlobject=io.BytesIO(raw)), RuntimeOptions())
        url = resp.body.data.image_url  # 结果是带透明通道的 PNG 临时链接
        with urllib.request.urlopen(url, timeout=20) as r:
            png = r.read()
        img = Image.open(io.BytesIO(png)).convert("RGBA")
        bbox = img.getbbox()
        return img.crop(bbox) if bbox else img
    except Exception:
        return None
