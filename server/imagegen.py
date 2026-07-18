"""插画生成通道：为教程卡生成统一画风的食材图标 / 步骤插图。

配置（data/config.json → "imagegen"），两种通道：
- openai-images：任意 OpenAI 兼容 /images/generations（OpenAI gpt-image-1、
  火山方舟 doubao-seedream、SiliconFlow、智谱 CogView 等）
- codex-cli：本机 codex CLI 的 image_gen（检测到二进制才可用）

示例：
{"imagegen": {"backend": "openai-images",
              "base_url": "https://ark.cn-beijing.volces.com/api/v3",
              "api_key_env": "ARK_API_KEY", "model": "doubao-seedream-4-0-250828"}}

风格规范见 docs/illustration-style.md —— STYLE_* 前缀是所有图共用的一致性锚点。
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request

from . import storage

CONFIG_FILE = storage.DATA / "config.json"

# 一致性锚点：逐字不变的画风前缀（与 docs/illustration-style.md 同步维护，改前缀=换画风）
STYLE_ANCHOR = (
    "贴纸式手绘卡通食物插画：深棕色粗描边（线宽均匀、略带手绘抖动），"
    "半厚涂水粉质感上色（固有色+暗部两阶明暗，加少量高光点），柔和的暖黄色顶光，"
    "色彩饱和明快、整体色温偏暖，温暖的米白色宣纸底色（#f4efe3，单一纯色背景），"
    "主体像手账贴纸一样贴在纸面上，轮廓完整清晰，无环境场景、无桌面、无投影。"
)
NEGATIVE_COMMON = (
    "不要：写实照片、3D 渲染、真实食物摄影质感；水印、logo、签名、乱码文字；"
    "黑色或深色背景；背景出现纸纹理颗粒/桌面/厨房/墙面/花纹；人物、人手、人脸；模糊、噪点、画面裁切不完整。"
)

ICON_SIZE = "1024x1024"
STEP_SIZE = "1024x768"


def _config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8")).get("imagegen", {})
    return {}


def backend_status() -> dict:
    cfg = _config()
    backend = cfg.get("backend") or ("codex-cli" if shutil.which("codex") else "")
    if backend == "openai-images":
        ok = bool(cfg.get("base_url")) and bool(os.environ.get(cfg.get("api_key_env", "")))
    elif backend == "codex-cli":
        ok = shutil.which("codex") is not None
    else:
        ok = False
    return {"backend": backend, "model": cfg.get("model", ""), "available": ok}


def ingredient_prompt(name: str, amount: str = "") -> str:
    desc = f"备菜量的{name}" + (f"（约{amount}）" if amount else "") + "，画出它的关键识别特征（颜色、纹理、形态）"
    return (f"{STYLE_ANCHOR}\n画面内容：{desc}。\n"
            "构图：单一食材居中，主体占画面 70%–80%，四周留出黑底边距，"
            "整体收在画面内切圆内（适配圆形裁切）；正面或 3/4 略俯视角度。\n"
            f"{NEGATIVE_COMMON}另外不要：多种食材混在一张图、切配好的成品菜、餐具堆叠。")


def step_prompt(step: str) -> str:
    return (f"{STYLE_ANCHOR}\n画面内容：把这个烹饪步骤画成道具拼贴——{step} "
            "用 2–4 个卡通化道具按时间顺序从左到右表达（木纹砧板、灰蓝汤锅、深灰平底锅——锅身不发纯黑且锅沿加暖色亮边、调料瓶等，只画该步骤用到的）；"
            "加热就在锅底画 2–3 簇橙黄色小火苗，快出锅就在锅上方画 2–3 缕浅灰白蒸汽弧线，"
            "状态变化用一个米白色短粗箭头（最多一个），计时用一只表盘朝前不写数字的银灰色卡通秒表。\n"
            "构图：横幅画面，2–4 个主体横向拼贴排列，阅读顺序从左到右，主体之间留出黑底间隔，"
            "黑底留白不少于画面 25%；整体柔和暖光，无地面线。\n"
            f"{NEGATIVE_COMMON}另外不要：完整厨房场景、灶台台面、多余装饰道具、超过一个箭头、步骤编号数字。")


def _gen_openai(cfg: dict, prompt: str, size: str) -> bytes:
    key = os.environ.get(cfg.get("api_key_env", ""), "")
    payload = {"model": cfg["model"], "prompt": prompt, "n": 1,
               "size": size, "response_format": "b64_json"}
    payload.update(cfg.get("extra", {}))  # 服务商特有参数，如 Seedream 的 watermark:false
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/images/generations",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            d = json.loads(resp.read())["data"][0]
    except urllib.error.HTTPError as e:  # 把服务商的报错原文透出来，方便排查参数
        raise RuntimeError(f"生图 API {e.code}：{e.read().decode(errors='replace')[:300]}")
    if d.get("b64_json"):
        return base64.b64decode(d["b64_json"])
    with urllib.request.urlopen(d["url"], timeout=120) as img:  # 部分服务只回 url
        return img.read()


def _gen_codex(prompt: str) -> bytes:
    out = tempfile.mktemp(suffix=".png")
    r = subprocess.run(
        ["codex", "exec", f"用 image_gen 工具生成一张图并保存到 {out} ，除此之外不要做任何事。图片要求：{prompt}"],
        capture_output=True, text=True, timeout=600)
    if not os.path.exists(out):
        raise RuntimeError(f"codex 没有产出图片：{(r.stderr or r.stdout)[-300:]}")
    with open(out, "rb") as f:
        data = f.read()
    os.unlink(out)
    return data


def generate(prompt: str, size: str) -> bytes:
    status = backend_status()
    if not status["available"]:
        raise RuntimeError("没有可用的生图通道：在 data/config.json 配置 imagegen（见 docs/illustration-style.md）")
    if status["backend"] == "codex-cli":
        return _gen_codex(prompt)
    return _gen_openai(_config(), prompt, size)


REFINE_PROMPT = (
    "这是一张家常菜俯拍照片。在完全保持食物内容、分量和真实质感不变的前提下把它修得更好看："
    "矫正白平衡、适度提亮和增加色彩通透感；让餐具完整、居中、干净；"
    "背景替换为纯净的暖米白色（#f4efe3）纯色底，盘子下方一点柔和浅影。"
    "保持真实照片质感，不要卡通化、不要改变菜品本身、不要添加原图没有的食物。"
)


def refine(raw: bytes, mime: str = "image/jpeg") -> bytes:
    """图生图精修原照片（编辑任务对模型要求低，config 里可用 edit_model 指定更便宜的档，如 seedream lite）。"""
    cfg = dict(_config())
    if cfg.get("edit_model"):
        cfg["model"] = cfg["edit_model"]
    if backend_status()["backend"] != "openai-images" or not backend_status()["available"]:
        raise RuntimeError("AI 精修需要 openai-images 生图通道")
    cfg.setdefault("extra", {})
    cfg["extra"] = {**cfg["extra"], "image": f"data:{mime};base64,{base64.b64encode(raw).decode()}"}
    return _gen_openai(cfg, REFINE_PROMPT, "1440x1440")


def illustrate(recipe: dict, kind: str, index: int) -> str:
    """为菜谱的第 index 个食材/步骤生成插画，返回可访问的 URL 路径。index 从 1 开始。"""
    cfg = _config()
    if kind == "ing":
        item = recipe["ingredients"][index - 1]
        prompt, size = ingredient_prompt(item["name"], item.get("amount", "")), cfg.get("size_icon", ICON_SIZE)
    else:
        prompt, size = step_prompt(recipe["steps"][index - 1]), cfg.get("size_step", STEP_SIZE)

    data = generate(prompt, size)
    out_dir = storage.PHOTOS / "illust" / recipe["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{kind}-{index}.png").write_bytes(data)
    return f"/photos/illust/{recipe['id']}/{kind}-{index}.png"
