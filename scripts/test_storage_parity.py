#!/usr/bin/env python3
"""存储对等测试：同一操作序列分别打在 文件模式 与 sqlite DB 模式 上，产出必须完全一致。

用法：.venv/bin/python scripts/test_storage_parity.py
原理：父进程各起一个子进程（环境变量选实现），子进程把每步结果打成 JSON 到 stdout，
父进程规范化（meal id 换成 M1/M2… 占位）后逐字节对比。
另验证：文件模式子进程绝不 import sqlalchemy（懒加载不泄漏）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------- 子进程：跑操作序列 ----------

def run_sequence() -> None:
    import server.storage as st

    out: list = []

    def rec(label: str, value) -> None:
        out.append([label, value])

    st.init_dirs()

    # 建菜谱（中文名 → 拼音 slug；克重各种脏值走 coerce）
    r1 = st.save_recipe({
        "name": "红烧肉", "category": "小炒", "cover": "", "source": "https://example.com/t",
        "created": "", "kcal": 2500, "minutes": 60, "difficulty": "中等", "servings": 3,
        "ingredients": [
            {"name": "带皮五花肉", "amount": "500克", "grams": 500},
            {"name": "生抽", "amount": "1勺", "grams": "15g"},   # 数字字符串 → 15
            {"name": "黄冰糖", "amount": "少许", "grams": True},  # bool → None
            {"name": "料酒", "amount": "", "grams": -3},          # 非法 → None
        ],
        "steps": ["五花肉冷水下锅焯水", "炒糖色下肉翻匀", "加水没过炖 40 分钟收汁"],
        "tips": ["下次少放盐"],
    })
    rec("r1 id", r1["id"])

    # 同名菜 → slug 加序号
    r2 = st.save_recipe({"name": "红烧肉", "category": "饭粥",
                         "ingredients": [], "steps": [], "tips": []})
    rec("r2 id (slug collision)", r2["id"])

    rec("get r1", st.get_recipe(r1["id"]))
    rec("get missing", st.get_recipe("mei-you-zhe-dao"))
    rec("get invalid id", st.get_recipe("BAD/../id"))
    rec("list_recipes", st.list_recipes())

    # 部分字段更新（app 层的合并语义：以旧菜谱为基底）
    old = st.get_recipe(r1["id"])
    merged = {k: old.get(k) for k in ("name", "category", "cover", "source", "created",
                                      "kcal", "minutes", "difficulty", "servings",
                                      "ingredients", "steps", "tips")}
    merged.update({"id": r1["id"], "category": "羹汤", "kcal": None, "cover": "/photos/cards/x.png"})
    st.save_recipe(merged)
    rec("get r1 after partial update", st.get_recipe(r1["id"]))

    # 显式非法 id 必须拒
    try:
        st.save_recipe({"id": "BadId", "name": "x", "ingredients": [], "steps": [], "tips": []})
        rec("save bad id", "no error (BUG)")
    except ValueError:
        rec("save bad id", "ValueError")

    # 记餐 / 改餐 / 删餐
    m1 = st.add_meal({"recipe_id": r1["id"], "date": "2026-07-01", "rating": 5,
                      "note": "好吃", "photo_card": "/photos/cards/p1-plate.png", "kcal": 833})
    m2 = st.add_meal({"recipe_id": r2["id"], "date": "2026-07-02", "rating": None,
                      "note": "", "photo_card": "", "kcal": None})
    m3 = st.add_meal({"recipe_id": r1["id"], "date": "2026-07-03", "rating": 3,
                      "note": "一般", "photo_card": "", "kcal": 833})
    mids = [m1["id"], m2["id"], m3["id"]]
    rec("add m1", m1)
    rec("add m2", m2)
    rec("add m3", m3)
    rec("list_meals", st.list_meals())
    rec("update m1", st.update_meal(mids[0], {"rating": 4, "note": "改：略咸", "date": "2026-07-01"}))
    rec("update missing", st.update_meal("m00000000000000", {"rating": 1}))
    rec("recipe_stats", st.recipe_stats())
    rec("delete m2", st.delete_meal(mids[1]))
    rec("delete m2 again", st.delete_meal(mids[1]))
    rec("list_meals after delete", st.list_meals())

    # 删菜谱（食历保留）
    rec("delete r2", st.delete_recipe(r2["id"]))
    rec("delete r2 again", st.delete_recipe(r2["id"]))
    rec("delete invalid", st.delete_recipe("BAD!"))
    rec("get r2 gone", st.get_recipe(r2["id"]))
    rec("stats after recipe delete", st.recipe_stats())

    # 杂项文档 read_doc / write_doc
    rec("orders missing", st.read_doc("orders"))
    st.write_doc("orders", [{"id": "o20260701", "from": "神秘食客", "note": "",
                             "items": [{"recipe_id": r1["id"], "name": "红烧肉"}],
                             "date": "2026-07-01", "done": False}])
    rec("orders", st.read_doc("orders"))
    st.write_doc("shopping", {"items": [{"name": "五花肉", "amounts": "500克",
                                         "recipes": "红烧肉", "checked": False, "seasoning": False}]})
    rec("shopping", st.read_doc("shopping"))
    st.write_doc("pantry", {"items": ["葱", "姜"]})
    rec("pantry", st.read_doc("pantry"))
    st.write_doc("pantry", {"items": ["蒜"]})  # 覆盖写
    rec("pantry overwritten", st.read_doc("pantry"))
    st.write_doc("config", {"llm": {"backend": "openai", "model": "deepseek-v4-flash"},
                            "guest": {"token": "abc123"}})
    rec("config", st.read_doc("config"))
    st.write_doc("ingredients/番茄", {"name": "番茄", "kcal_per_100g": 15.0,
                                      "benefits": ["含维生素C"], "tips": []})
    rec("ingredient doc", st.read_doc("ingredients/番茄"))
    rec("ingredient missing", st.read_doc("ingredients/不存在"))
    rec("ingredient names", st.list_doc_names("ingredients/"))

    # 纯函数口径
    rec("coerce_grams", [st.coerce_grams(v) for v in
                         [50, "55g", "1_0", True, False, -1, 0, 1e400, "abc", None, "3.6", 100_001]])
    rec("valid_id", [st.valid_id(x) for x in ["abc-1", "ABC", "", "a/b", "a_b", "r38402"]])

    # 规范化：meal id 是时间戳，两次运行必然不同 → 换成占位符再对比
    mapping = {mid: f"M{i + 1}" for i, mid in enumerate(mids)}

    def norm(v):
        if isinstance(v, str):
            return mapping.get(v, v)
        if isinstance(v, list):
            return [norm(x) for x in v]
        if isinstance(v, dict):
            return {k: norm(x) for k, x in v.items()}
        return v

    print(json.dumps(norm(out), ensure_ascii=False, sort_keys=True, indent=1))
    print(f"sqlalchemy_imported={'sqlalchemy' in sys.modules}", file=sys.stderr)


# ---------- 父进程：双模式对比 ----------

def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="yidanshi-parity-"))
    runs = {
        "file": {"YIDANSHI_DATA_DIR": str(tmp / "filedata")},
        "db": {"YIDANSHI_DATA_DIR": str(tmp / "dbdata"),
               "YIDANSHI_DB_URL": f"sqlite:///{tmp / 'parity.db'}"},
    }
    outputs, sqla = {}, {}
    for mode, extra in runs.items():
        env = {k: v for k, v in os.environ.items()
               if k not in ("YIDANSHI_DB_URL", "YIDANSHI_DATA_DIR",
                            "MYSQL_ADDRESS", "MYSQL_USERNAME", "MYSQL_PASSWORD")}
        env.update(extra)
        env["PYTHONPATH"] = str(ROOT)
        p = subprocess.run([sys.executable, __file__, "--child"], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            print(f"[{mode}] 子进程失败：\n{p.stderr}")
            return 1
        outputs[mode] = p.stdout
        sqla[mode] = "sqlalchemy_imported=True" in p.stderr

    if sqla["file"]:
        print("FAIL：文件模式 import 了 sqlalchemy（懒加载泄漏）")
        return 1
    print(f"文件模式未加载 sqlalchemy ✓（DB 模式加载了 sqlalchemy：{sqla['db']}）")

    if outputs["file"] == outputs["db"]:
        steps = len(json.loads(outputs["file"]))
        print(f"PASS：{steps} 步操作序列，文件模式 与 sqlite DB 模式 输出完全一致")
        return 0

    print("FAIL：两种模式输出不一致——")
    a, b = (json.loads(outputs[m]) for m in ("file", "db"))
    for x, y in zip(a, b):
        if x != y:
            print(f"  第一处差异 [{x[0]}]:\n    file: {json.dumps(x[1], ensure_ascii=False)}"
                  f"\n    db:   {json.dumps(y[1], ensure_ascii=False)}")
            break
    return 1


if __name__ == "__main__":
    if "--child" in sys.argv:
        run_sequence()
    else:
        sys.exit(main())
