#!/usr/bin/env python3
"""为一道菜生成统一画风的插画 prompt 清单（AB 风教程卡用）。

用法：.venv/bin/python scripts/gen_illust_prompts.py <recipe-id>

输出 data/photos/illust/<recipe-id>/prompts.md —— 每张插画一条 prompt，
交给任意图像生成工具（如 Codex 的 image_gen）批量出图后，把成图按文件名
存回同目录（ing-1.png、step-1.png…），教程卡页面即自动显示。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import storage  # noqa: E402

STYLE = (
    "手绘厚涂卡通插画，纯黑深色背景（#0d0d0d），暖色柔光，简洁居中构图，"
    "无文字无水印，食物插画风格统一，类似日式料理漫画的温暖质感"
)

def main(rid: str) -> None:
    r = storage.get_recipe(rid)
    if r is None:
        sys.exit(f"没有这道菜：{rid}（data/recipes/ 下应有 {rid}.md）")
    out_dir = storage.PHOTOS / "illust" / rid
    out_dir.mkdir(parents=True, exist_ok=True)

    lines = [f"# {r['name']} · 插画生成清单", "", f"统一画风：{STYLE}", ""]
    lines.append("## 食材图标（圆形小图，单一食材特写）\n")
    for n, ing in enumerate(r["ingredients"], 1):
        lines.append(f"- `ing-{n}.png` ← {STYLE}。画面内容：单个食材特写——{ing['name']}"
                     + (f"（{ing['amount']}）" if ing["amount"] else "") + "，圆形构图友好。")
    lines.append("\n## 步骤插图（横图 4:3，烹饪过程示意）\n")
    for n, step in enumerate(r["steps"], 1):
        lines.append(f"- `step-{n}.png` ← {STYLE}。画面内容：烹饪步骤示意——{step}")
    (out_dir / "prompts.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已写入 {out_dir / 'prompts.md'}（{len(r['ingredients'])} 个食材图标 + {len(r['steps'])} 张步骤图）")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
