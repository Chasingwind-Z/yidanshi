"""AI 通道：把社交媒体教程原文提炼成结构化菜谱。

后端可配置（data/config.json → "llm"），三种通道：
- claude-cli：调本机 claude CLI（复用 Claude 订阅，默认）
- codex-cli：调本机 codex CLI
- openai：任意 OpenAI 兼容 API（DeepSeek、Qwen、GLM 等；base_url + api_key_env + model）

示例 data/config.json：
{"llm": {"backend": "openai", "base_url": "https://api.deepseek.com/v1",
         "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-chat"}}
注意：DeepSeek 目前纯文本不支持图片输入；图片相关能力请用 claude-cli。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.request

from . import storage

CONFIG_FILE = storage.DATA / "config.json"

# launchd 环境 PATH 很干净，把 CLI 常见安装位置补进来
_EXTRA = [os.path.expanduser("~/.local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
os.environ["PATH"] = os.environ.get("PATH", "") + ":" + ":".join(_EXTRA)

PROMPT = """把下面这段做菜内容整理成结构化菜谱。它可能是社交媒体教程文案，也可能是用户自己随口描述的做法回忆——口语、跳跃、不完整都正常。规则：
- 忠实整理，不要发明原文没有的食材和步骤
- 食材**主料和调料都要列全**（步骤里提到的生抽/蚝油/盐/糖/淀粉等也单独列出）；用量原文有就用原文的，没有就按常见做法估一个（如"1勺""10毫升""少许"），主料尽量给克数或个数
- 步骤合并成3-6步，每步一句话说清楚动作和火候/时长
- 原文里的个人经验（"下次少放盐"这类）归入 tips
- kcal：按食材用量估算单人份总热量（整数千卡），无法估算给 null
- minutes：预估从备菜到出锅的总耗时（整数分钟，含腌制等等待时间），无法估算给 null
- difficulty：从 简单/中等/硬菜 三档选一个（看步骤复杂度、火候和技巧要求）
只输出一个 JSON 对象，不要任何其他文字：
{{"name": "菜名", "category": "从 饭粥/面点/羹汤/小炒/甜点 中选一个",
  "ingredients": [{{"name": "食材名", "amount": "用量"}}],
  "steps": ["..."],
  "tips": ["没有就给空数组"],
  "kcal": 472, "minutes": 25, "difficulty": "简单"}}

原文：
{text}"""


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
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8")).get("llm", {})
    return {}


def backend_status() -> dict:
    cfg = config()
    backend = cfg.get("backend") or ("claude-cli" if shutil.which("claude")
                                     else "codex-cli" if shutil.which("codex") else "")
    ok = bool(backend) and (backend != "openai" or bool(os.environ.get(cfg.get("api_key_env", ""))))
    return {"backend": backend, "model": cfg.get("model", ""), "available": ok}


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
        out = _run_openai(config(), prompt)

    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise RuntimeError(f"AI 输出里没有 JSON：{out[:200]}")
    r = json.loads(m.group())
    kcal, minutes = r.get("kcal"), r.get("minutes")
    return {
        "difficulty": r.get("difficulty") if r.get("difficulty") in ("简单", "中等", "硬菜") else None,
        "minutes": int(minutes) if isinstance(minutes, (int, float)) else None,
        "name": str(r.get("name", "")).strip(),
        "category": r.get("category") if r.get("category") in storage.DEFAULT_CATEGORIES else storage.DEFAULT_CATEGORIES[3],
        "ingredients": [{"name": str(i.get("name", "")).strip(), "amount": str(i.get("amount", "")).strip()}
                        for i in r.get("ingredients", []) if i.get("name")],
        "steps": [str(s).strip() for s in r.get("steps", []) if str(s).strip()],
        "tips": [str(t).strip() for t in r.get("tips", []) if str(t).strip()],
        "kcal": int(kcal) if isinstance(kcal, (int, float)) else None,
        "source": source,
    }
