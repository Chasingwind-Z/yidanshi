"""照片存储：COS 配齐（COS_SECRET_ID/COS_SECRET_KEY/COS_REGION/COS_BUCKET 四个都设）
→ 上传对象存储 photos/<kind>/<name>，字段里存完整 https URL；
否则写本地 data/photos/<kind>/<name>，返回 /photos/<kind>/<name>（现状，逐字节不变）。

读照片统一走 fetch(ref)：字段值 http(s) 开头就 urllib 拉字节（默认超时 5s，失败 None），
否则按本地路径。cos SDK 懒加载，本地模式绝不 import。
"""
from __future__ import annotations

import os
import urllib.request

from . import storage


def _cos_conf() -> dict | None:
    vals = {k: os.environ.get(k, "").strip()
            for k in ("COS_SECRET_ID", "COS_SECRET_KEY", "COS_REGION", "COS_BUCKET")}
    return vals if all(vals.values()) else None


_client = None


def _cos_client(conf: dict):
    global _client
    if _client is None:
        from qcloud_cos import CosConfig, CosS3Client

        _client = CosS3Client(CosConfig(Region=conf["COS_REGION"],
                                        SecretId=conf["COS_SECRET_ID"],
                                        SecretKey=conf["COS_SECRET_KEY"]))
    return _client


def url_for(kind: str, name: str) -> str:
    """某张照片的规范 URL（不落盘）：COS 模式 = 完整 https，本地模式 = /photos/ 相对路径。"""
    conf = _cos_conf()
    if conf:
        return f"https://{conf['COS_BUCKET']}.cos.{conf['COS_REGION']}.myqcloud.com/photos/{kind}/{name}"
    return f"/photos/{kind}/{name}"


def _save_local(kind: str, name: str, data: bytes) -> str:
    p = storage.PHOTOS / kind / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return f"/photos/{kind}/{name}"


def save(kind: str, name: str, data: bytes) -> str:
    """存一张照片，返回可写进数据字段的 URL。

    COS 侧任何异常（凭证错/桶名错/网络抖/SDK 缺）都不该打死拍照上传——降级写本地兜底，
    这一张至少存下来了。部署前 scripts/cloud_preflight.py 会先探明 COS 连通性，
    所以这里的降级只兜临时故障，不掩盖长期配错。"""
    conf = _cos_conf()
    if conf:
        try:
            _cos_client(conf).put_object(Bucket=conf["COS_BUCKET"],
                                         Key=f"photos/{kind}/{name}", Body=data)
            return url_for(kind, name)
        except Exception:  # noqa: BLE001 —— COS SDK 异常类型繁杂，一律降级
            global _client
            _client = None  # 连接可能已坏，下次重建
    return _save_local(kind, name, data)


def fetch(ref: str, timeout: float = 5) -> bytes | None:
    """按字段值读照片字节：http(s) → urllib 拉取（超时即放弃），/photos/… → 本地文件；
    失败/不存在一律返回 None，调用方自行跳过。"""
    if not ref:
        return None
    if ref.startswith(("http://", "https://")):
        try:
            with urllib.request.urlopen(ref, timeout=timeout) as resp:
                return resp.read()
        except Exception:
            return None
    p = storage.PHOTOS / ref.removeprefix("/photos/")
    try:
        return p.read_bytes() if p.exists() else None
    except OSError:
        return None


def load(kind: str, name: str) -> bytes | None:
    """按 kind/name 读照片字节（COS 或本地），不存在返回 None。"""
    return fetch(url_for(kind, name))
