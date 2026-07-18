#!/usr/bin/env python3
"""为一道菜导出插画 prompt 清单（与 App 内自动生图同一套话术，风格见 docs/illustration-style.md）。

用法：.venv/bin/python scripts/gen_illust_prompts.py <recipe-id>

输出 data/photos/illust/<recipe-id>/prompts.md —— 想手动用别的生图工具出图时用；
出图后按文件名（ing-1.png、step-1.png…）放回同目录，教程卡即自动显示。
App 内一键生成走 server/imagegen.py，不需要本脚本。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import imagegen, storage  # noqa: E402


def main(rid: str) -> None:
    r = storage.get_recipe(rid)
    if r is None:
        sys.exit(f"没有这道菜：{rid}（data/recipes/ 下应有 {rid}.md）")
    out_dir = storage.PHOTOS / "illust" / rid
    out_dir.mkdir(parents=True, exist_ok=True)

    lines = [f"# {r['name']} · 插画生成清单", "",
             "风格规范：docs/illustration-style.md（每条 prompt 已拼好，直接发给生图工具）", ""]
    for n, ing in enumerate(r["ingredients"], 1):
        lines += [f"## `ing-{n}.png`（{ing['name']}，{imagegen.ICON_SIZE}）", "",
                  "```", imagegen.ingredient_prompt(ing["name"], ing.get("amount", "")), "```", ""]
    for n, step in enumerate(r["steps"], 1):
        lines += [f"## `step-{n}.png`（步骤{n}，{imagegen.STEP_SIZE}）", "",
                  "```", imagegen.step_prompt(step), "```", ""]
    (out_dir / "prompts.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已写入 {out_dir / 'prompts.md'}（{len(r['ingredients'])} 食材 + {len(r['steps'])} 步骤）")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
