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

PROMPT = """把下面的做菜教程原文提炼成结构化菜谱，只输出一个 JSON 对象，不要任何其他文字：
{{"name": "菜名", "category": "从 一碗饭/一碗面/一碗汤/一碗菜/一碗甜 中选一个",
  "ingredients": [{{"name": "食材名", "amount": "用量"}}],
  "steps": ["步骤合并成3-6步，每步一句话说清楚"],
  "tips": ["贴士，没有就给空数组"]}}

教程原文：
{text}"""


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
    return {
        "name": str(r.get("name", "")).strip(),
        "category": r.get("category") if r.get("category") in storage.DEFAULT_CATEGORIES else storage.DEFAULT_CATEGORIES[3],
        "ingredients": [{"name": str(i.get("name", "")).strip(), "amount": str(i.get("amount", "")).strip()}
                        for i in r.get("ingredients", []) if i.get("name")],
        "steps": [str(s).strip() for s in r.get("steps", []) if str(s).strip()],
        "tips": [str(t).strip() for t in r.get("tips", []) if str(t).strip()],
        "source": source,
    }
