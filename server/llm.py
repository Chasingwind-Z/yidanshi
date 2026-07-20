"""AI 通道：把社交媒体教程原文提炼成结构化菜谱。

后端可配置（data/config.json → "llm"），三种通道：
- claude-cli：调本机 claude CLI（复用 Claude 订阅，默认）
- codex-cli：调本机 codex CLI
- openai：任意 OpenAI 兼容 API（DeepSeek、Qwen、GLM 等；base_url + api_key_env + model）

示例 data/config.json（DeepSeek）：
{"llm": {"backend": "openai", "base_url": "https://api.deepseek.com",
         "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-v4-flash"}}
注意：① 模型用 deepseek-v4-flash（旧的 deepseek-chat 已下线）、base_url 无 /v1，与本文件
_DEEPSEEK_DEFAULTS 一致；② DeepSeek 纯文本不支持图片输入，图片相关能力请用 claude-cli。
其实无需手配：设了 DEEPSEEK_API_KEY 且本机无 claude/codex CLI 时，自动走这套默认值。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.request

from . import storage

CONFIG_FILE = storage.DATA / "config.json"  # 仅文件模式的物理位置；读写一律走 storage.read_doc/write_doc

# launchd 环境 PATH 很干净，把 CLI 常见安装位置补进来
_EXTRA = [os.path.expanduser("~/.local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
os.environ["PATH"] = os.environ.get("PATH", "") + ":" + ":".join(_EXTRA)

PROMPT = """把下面这段做菜内容整理成结构化菜谱。它可能是社交媒体教程文案，也可能是用户自己随口描述的做法回忆——口语、跳跃、不完整都正常。规则：
- 忠实整理，不要发明原文没有的食材和步骤
- 食材**主料和调料都要列全**（步骤里提到的生抽/蚝油/盐/糖/淀粉等也单独列出）；用量原文有就用原文的，没有就按常见做法估一个（如"1勺""10毫升""少许"）；每个食材再估一个 grams（该菜实际用到的克数，如鸡蛋1个≈55、生抽1勺≈15）
- 步骤合并成3-6步，每步一句话说清楚动作和火候/时长
- 原文里的个人经验（"下次少放盐"这类）归入 tips
- kcal：按食材用量估算单人份总热量（整数千卡），无法估算给 null
- minutes：预估从备菜到出锅的总耗时（整数分钟，含腌制等等待时间），无法估算给 null
- difficulty：从 简单/中等/硬菜 三档选一个（看步骤复杂度、火候和技巧要求）
- servings：这份食材量正常吃是几餐（如 500 克五花肉一锅≈3 餐取 3；一人一顿的量取 1）
只输出一个 JSON 对象，不要任何其他文字：
{{"name": "菜名", "category": "从 饭粥/面点/羹汤/小炒/甜点 中选一个",
  "ingredients": [{{"name": "食材名", "amount": "用量", "grams": 55}}],
  "steps": ["..."],
  "tips": ["没有就给空数组"],
  "kcal": 472, "minutes": 25, "difficulty": "简单", "servings": 1}}

原文：
{text}"""


ING_PROMPT = """介绍食材「{name}」。数值按《中国食物成分表》常见参考值（可食部每100克；调味品同理）。
只输出一个 JSON，不要其他文字；下面示例里的数字只是占位示意格式，务必换成「{name}」本身的真实参考值：
{{"name": "{name}", "kcal_per_100g": 0.0, "protein_g": 0.0, "fat_g": 0.0, "carb_g": 0.0,
  "benefits": ["2-3条主要营养特点/功效，每条一句话，客观不夸大；禁止疾病预防/治疗类表述"],
  "tips": ["1-2条实用小贴士（挑选/储存/烹饪注意），每条一句话"]}}
不确定的数值字段给 null。
若「{name}」是成品包装食品/预制正餐（方便面、自热饭火锅、速冻水饺、饭团、预制菜、薯片饼干等零食）：
数值字段一律给 null（不同品牌配方差异极大，不要编造精确值），并在 tips 里明确写「不同品牌配方差异大，请以包装营养成分表为准」。"""


def ingredient_info(name: str) -> dict:
    status = backend_status()
    if not status["available"]:
        raise RuntimeError("没有可用的 AI 通道")
    prompt = ING_PROMPT.format(name=name.strip()[:20])
    backend = status["backend"]
    if backend == "claude-cli":
        out = _run_cli(["claude", "-p"], prompt)
    elif backend == "codex-cli":
        out = _run_cli(["codex", "exec"], prompt)
    else:
        out = _run_openai(_effective_config(), prompt)
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise RuntimeError("AI 输出里没有 JSON")
    r = json.loads(m.group())
    num = lambda v: round(float(v), 1) if isinstance(v, (int, float)) else None
    return {"name": name, "kcal_per_100g": num(r.get("kcal_per_100g")),
            "protein_g": num(r.get("protein_g")), "fat_g": num(r.get("fat_g")), "carb_g": num(r.get("carb_g")),
            "benefits": [str(x).strip() for x in r.get("benefits", []) if str(x).strip()][:3],
            "tips": [str(x).strip() for x in r.get("tips", []) if str(x).strip()][:2]}


def fetch_link_text(url: str) -> str:
    """从分享链接尽力抓取文案（抖音分享页/通用 og 标签），失败返回空串由调用方兜底。"""
    import html as _html

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            page = resp.read(1_500_000).decode("utf-8", errors="replace")
    except Exception:
        return ""

    texts: list[str] = []
    m = re.search(r'"desc":"((?:[^"\\]|\\.)*)"', page)  # 抖音分享页内嵌 JSON 的文案字段
    if m:
        try:
            texts.append(json.loads(f'"{m.group(1)}"'))
        except Exception:
            pass
    for pat in (r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"',
                r'<meta[^>]+property="og:description"[^>]+content="([^"]*)"',
                r"<title>([^<]*)</title>"):
        m = re.search(pat, page)
        if m and m.group(1).strip():
            texts.append(_html.unescape(m.group(1).strip()))
    seen, out = set(), []
    for t in texts:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return "\n".join(out).strip()


def config() -> dict:
    return (storage.read_doc("config") or {}).get("llm", {})


# 自动链兜底（云端无 claude/codex CLI 时）：有 DEEPSEEK_API_KEY 就走 openai 通道。
# 注意 deepseek-chat 已下线，用 deepseek-v4-flash。
_DEEPSEEK_DEFAULTS = {"backend": "openai", "base_url": "https://api.deepseek.com",
                      "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-v4-flash"}


def _effective_config() -> dict:
    """生效配置：config.json 显式 backend 最优先；否则自动链
    claude-cli → codex-cli → （设了 DEEPSEEK_API_KEY 时）openai/DeepSeek。"""
    cfg = config()
    if cfg.get("backend"):
        return cfg
    if shutil.which("claude"):
        return {**cfg, "backend": "claude-cli"}
    if shutil.which("codex"):
        return {**cfg, "backend": "codex-cli"}
    if os.environ.get("DEEPSEEK_API_KEY"):
        return {**_DEEPSEEK_DEFAULTS, **{k: v for k, v in cfg.items() if v}}
    return cfg


def backend_status() -> dict:
    eff = _effective_config()
    backend = eff.get("backend", "")
    ok = bool(backend) and (backend != "openai" or bool(os.environ.get(eff.get("api_key_env", ""))))
    return {"backend": backend, "model": eff.get("model", ""), "available": ok}


def _run_cli(cmd: list[str], prompt: str) -> str:
    r = subprocess.run(cmd + [prompt], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} 退出码 {r.returncode}：{r.stderr[-300:]}")
    return r.stdout


def _run_openai(cfg: dict, prompt: str) -> str:
    key = os.environ.get(cfg.get("api_key_env", ""), "")
    if not key:
        raise RuntimeError(f"环境变量 {cfg.get('api_key_env')} 未设置")
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps({"model": cfg["model"],
                         "messages": [{"role": "user", "content": prompt}],
                         "temperature": 0.2}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def extract_recipe(text: str, source: str = "") -> dict:
    status = backend_status()
    if not status["available"]:
        raise RuntimeError("没有可用的 AI 通道：装 claude/codex CLI，或在 data/config.json 配置 openai 兼容 API")

    prompt = PROMPT.format(text=text.strip()[:6000])
    backend = status["backend"]
    if backend == "claude-cli":
        out = _run_cli(["claude", "-p"], prompt)
    elif backend == "codex-cli":
        out = _run_cli(["codex", "exec"], prompt)
    else:
        out = _run_openai(_effective_config(), prompt)

    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise RuntimeError(f"AI 输出里没有 JSON：{out[:200]}")
    r = json.loads(m.group())
    kcal, minutes = r.get("kcal"), r.get("minutes")
    return {
        "difficulty": r.get("difficulty") if r.get("difficulty") in ("简单", "中等", "硬菜") else None,
        "servings": int(r["servings"]) if isinstance(r.get("servings"), (int, float)) and r["servings"] >= 1 else 1,
        "minutes": int(minutes) if isinstance(minutes, (int, float)) else None,
        "name": str(r.get("name", "")).strip(),
        "category": r.get("category") if r.get("category") in storage.DEFAULT_CATEGORIES else storage.DEFAULT_CATEGORIES[3],
        "ingredients": [{"name": str(i.get("name", "")).strip(), "amount": str(i.get("amount", "")).strip(),
                         "grams": round(float(i["grams"])) if isinstance(i.get("grams"), (int, float)) else None}
                        for i in r.get("ingredients", []) if i.get("name")],
        "steps": [str(s).strip() for s in r.get("steps", []) if str(s).strip()],
        "tips": [str(t).strip() for t in r.get("tips", []) if str(t).strip()],
        "kcal": int(kcal) if isinstance(kcal, (int, float)) else None,
        "source": source,
    }
