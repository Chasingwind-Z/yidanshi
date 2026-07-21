"""把本地 data/ 的照片+插画+菜谱封面+食历迁到云端（COS + 云托管 MySQL）。

一次性脚本：
1. 本地 data/photos/{cards,illust}/** 全量上传到 COS（镜像同样的 key 路径）。
2. 每道菜谱的 cover 字段更新成 COS URL（PUT 云端 /api/recipes/{id}，带主人 openid）。
3. 本地 meals.json 的记录补进云端（POST /api/meals，按 date+recipe_id 去重，可重复运行）。

云端读 COS 用 storage._cos_base 构造 URL；插画走 _attach_illust 的 COS 分支。
凭证从 data/secrets.env 读，只上传不删除。用法：
  .venv/bin/python scripts/migrate_to_cloud.py            # 真跑
  .venv/bin/python scripts/migrate_to_cloud.py --dry      # 只看要做什么
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CLOUD = "https://yidanshi-284630-10-1456112658.sh.run.tcloudbase.com"
OPENID = "oTv9a3Sp9YZaMs0RExvEgWbNbWvU"
DRY = "--dry" in sys.argv


def _secret(k: str) -> str:
    for ln in (ROOT / "data" / "secrets.env").read_text(encoding="utf-8").splitlines():
        if ln.startswith(f"{k}="):
            return ln.split("=", 1)[1].strip()
    return ""


SID, SK = _secret("COS_SECRET_ID"), _secret("COS_SECRET_KEY")
REGION, BUCKET = _secret("COS_REGION"), _secret("COS_BUCKET")
HOST = f"{BUCKET}.cos.{REGION}.myqcloud.com"
COS_BASE = f"https://{HOST}"


def _cos_put(key: str, data: bytes, ctype: str = "image/png") -> int:
    now = int(time.time()); exp = now + 300; ktime = f"{now};{exp}"
    signkey = hmac.new(SK.encode(), ktime.encode(), hashlib.sha1).hexdigest()
    fmt = f"put\n/{key}\n\nhost={HOST}\n"
    sig = hmac.new(signkey.encode(), f"sha1\n{ktime}\n{hashlib.sha1(fmt.encode()).hexdigest()}\n".encode(),
                   hashlib.sha1).hexdigest()
    auth = (f"q-sign-algorithm=sha1&q-ak={SID}&q-sign-time={ktime}&q-key-time={ktime}"
            f"&q-header-list=host&q-url-param-list=&q-signature={sig}")
    # 签名用原始 key（COS 签解码路径），请求 URL 里中文键要 %XX 编码，否则 urllib 发不出去
    url_key = urllib.parse.quote(key, safe="/")
    req = urllib.request.Request(f"{COS_BASE}/{url_key}", data=data, method="PUT",
                                 headers={"Host": HOST, "Authorization": auth, "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def _cloud(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CLOUD + path, data=data, method=method,
                                 headers={"X-WX-OPENID": OPENID, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.status, json.loads(e.read() or "{}")


def main() -> None:
    assert all((SID, SK, REGION, BUCKET)), "COS 凭证不全，先配 data/secrets.env"
    from server import storage

    # 1) 上传所有本地照片（cards + illust）到 COS
    photos = storage.PHOTOS
    # 只传图片；跳过 prompts.md 之类非图、以及已删菜谱 paomian-plus 的孤儿插画
    files = [p for sub in ("cards", "illust") for p in (photos / sub).rglob("*")
             if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg") and "paomian-plus" not in p.parts]
    print(f"[1/3] 上传 {len(files)} 张照片到 COS …")
    up = 0
    for p in files:
        key = f"photos/{p.relative_to(photos).as_posix()}"
        if DRY:
            print("   would PUT", key); continue
        try:
            _cos_put(key, p.read_bytes(), "image/png" if p.suffix == ".png" else "application/octet-stream")
            up += 1
        except Exception as e:  # noqa: BLE001
            print("   ✗ 上传失败", key, e)
    print(f"       上传完成 {up}/{len(files)}")

    # 2) 更新云端菜谱 cover
    print("[2/3] 更新云端菜谱封面 …")
    for r in storage.list_recipes():
        cover = r.get("cover", "")
        if not cover.startswith("/photos/"):
            continue
        cos_url = COS_BASE + cover
        if DRY:
            print("   would PUT cover", r["id"], "→", cos_url[:60]); continue
        st, _ = _cloud("PUT", f"/api/recipes/{r['id']}", {"cover": cos_url})
        print(f"   {'✓' if st == 200 else '✗ '+str(st)} {r['id']}  {r['name']}")

    # 3) 迁移食历（按 date+recipe_id 去重，可重复运行）
    print("[3/3] 迁移食历记录 …")
    st, cloud_meals = _cloud("GET", "/api/meals")
    have = {(m["date"], m["recipe_id"]) for m in (cloud_meals if isinstance(cloud_meals, list) else [])}
    for m in storage.list_meals():
        key = (m["date"], m.get("recipe_id"))
        if key in have:
            print("   ⊝ 已存在，跳过", m["date"], m.get("recipe_name")); continue
        pid = Path(m.get("photo_card", "")).stem  # /photos/cards/xxx.png → xxx
        body = {"recipe_id": m["recipe_id"], "date": m["date"],
                "rating": m.get("rating"), "note": m.get("note", ""),
                "photo_id": pid or None}
        if DRY:
            print("   would POST meal", m["date"], m.get("recipe_name")); continue
        st, resp = _cloud("POST", "/api/meals", body)
        print(f"   {'✓' if st == 200 else '✗ '+str(st)+' '+str(resp)} {m['date']} {m.get('recipe_name')}")

    print("完成。" + ("（--dry 预演，未实际写入）" if DRY else ""))


if __name__ == "__main__":
    main()
