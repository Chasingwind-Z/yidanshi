"""多租户回填：把现有单租户生产数据认领成「主人的厨房」（第一个租户）。

一次性脚本，幂等、可重复跑，不在服务启动时自动执行。要在能连到目标 MySQL 的环境跑
（云端容器内，或本地起了到生产库的隧道）——跟 storage.py 一样，靠 YIDANSHI_DB_URL /
MYSQL_ADDRESS 等环境变量决定连哪个库。

这个脚本只是把数据认领好；真正切换多租户还要另外把 YIDANSHI_MULTI_TENANT=1 加进云端
环境变量——两件事分开做，回填完不代表已经开放公开访问，是两步独立、都要主人自己确认的动作。

用法：
  .venv/bin/python scripts/migrate_multi_tenant.py            # 真跑
  .venv/bin/python scripts/migrate_multi_tenant.py --dry      # 只看要做什么
"""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DRY = "--dry" in sys.argv


def main() -> None:
    from server import storage

    owner_openid = os.environ.get("YIDANSHI_OWNER_OPENID", "").strip()
    if not owner_openid:
        print("没配 YIDANSHI_OWNER_OPENID，不知道该把现有数据认领给谁——先把这个 env 配好再跑。")
        sys.exit(1)

    if storage.health()["mode"] != "db":
        print("当前环境是文件模式（没检测到 YIDANSHI_DB_URL / MYSQL_ADDRESS）——多租户只在"
              "数据库模式下有意义，这个脚本不该在文件模式跑，退出。")
        sys.exit(1)

    print(f"[1/3] 认领 recipes/meals 给厨房 {owner_openid} …")
    pending = storage.count_unowned()
    print(f"   待认领：recipes {pending['recipes']} 条，meals {pending['meals']} 条")
    if not DRY:
        claimed = storage.claim_unowned(owner_openid)
        print(f"   已认领：recipes {claimed['recipes']} 条，meals {claimed['meals']} 条")

    print("[2/3] 开通/补全主人的厨房，沿用旧的客人点菜口令 …")
    cfg = storage.read_doc("config") or {}
    old_token = cfg.get("guest", {}).get("token", "")
    existing = storage.get_kitchen(owner_openid)
    if existing is None:
        print(f"   新建厨房 {owner_openid}"
              f"（guest_token={'沿用旧口令 ' + old_token if old_token else '暂无，等主人首次用再生成'}）")
        if not DRY:
            storage.upsert_kitchen(owner_openid, name="主人的小厨房",
                                    created=date.today().isoformat(),
                                    guest_token=old_token, cutout_count=0,
                                    cutout_count_date="", photo_count=0)
    else:
        print(f"   厨房 {owner_openid} 已存在，跳过建厨房"
              f"（当前 guest_token={'已有' if existing.get('guest_token') else '空'}）")
        if old_token and not existing.get("guest_token") and not DRY:
            storage.upsert_kitchen(owner_openid, guest_token=old_token)
            print("   补上了旧的客人点菜口令，之前发出去的链接继续有效")

    print("[3/3] 复制 orders/shopping/pantry 到带厨房前缀的文档（config 不搬，见 app.py 里"
          "_require_owner_kitchen 的注释——AI 配置的多厨房读写是 M2 才做的事）…")
    for base in ("orders", "shopping", "pantry"):
        doc = storage.read_doc(base)
        namespaced = storage.doc_name(base, owner_openid)
        if doc is None:
            print(f"   {base}: 原文档不存在，跳过")
            continue
        if storage.read_doc(namespaced) is not None:
            print(f"   {namespaced}: 已存在，跳过（脚本可重复跑，不覆盖已迁移过的）")
            continue
        print(f"   {base} → {namespaced}")
        if not DRY:
            storage.write_doc(namespaced, doc)

    print("完成。" + ("（--dry 预演，未实际写入）" if DRY else
          "\n数据已认领好。要真正开放公开访问，还需要主人自己在云端环境变量里加"
          "YIDANSHI_MULTI_TENANT=1 并重启服务——这一步这个脚本不会替你做。"))


if __name__ == "__main__":
    main()
