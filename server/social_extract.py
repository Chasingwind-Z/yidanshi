"""社媒链接抓取：识别平台 → 各自最靠谱的抓法 → 统一返回 {text, video_url}。

支持抖音（分享页内嵌 JSON）、小红书（explore 链接的 __INITIAL_STATE__）、
B站（官方公开 API，最干净，无需扒页面）——三家都实测过：真实标题/文案能拿到，
且都能顺手拿到视频直链（喂给 doubao 视频理解用）。

知乎等其余平台：直接被 WAF 拦（403，加常见浏览器头也过不去，需要真实浏览器
内核才能绕，对个人项目不值得加这个重量级依赖）。这些平台统一走通用 og 标签
兜底，抓不到就是抓不到——上层看 text 是否够长，不够就走已有的诚实报错
「这个链接抓不到文案，去 App 里长按复制文案粘过来吧」。
"""
from __future__ import annotations

import html as _html
import json
import re
import urllib.request

_UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
_UA_DESKTOP = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def detect_platform(url: str) -> str:
    if re.search(r"douyin\.com", url):
        return "douyin"
    if re.search(r"xiaohongshu\.com|xhslink\.com", url):
        return "xiaohongshu"
    if re.search(r"bilibili\.com|b23\.tv", url):
        return "bilibili"
    return "other"


def _get(url: str, ua: str = _UA_MOBILE, referer: str | None = None, timeout: int = 20) -> str:
    headers = {"User-Agent": ua}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(2_000_000).decode("utf-8", errors="replace")


def _resolve_redirect(url: str, ua: str = _UA_MOBILE, timeout: int = 15) -> str:
    """跟到最终地址——喂给 doubao 视频理解前必须做这一步：中间跳转地址（如抖音的
    playwm 短链）doubao 服务器自己连过去经常超时（实测证实），CDN 最终签名直链才连得通。"""
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.geturl()


def _jstr(m: re.Match | None) -> str:
    """正则抠出来的 JSON 字符串片段（可能带 \\uXXXX/\\" 转义）解码成真实文本，抠不到给空串。"""
    if not m:
        return ""
    try:
        return json.loads(f'"{m.group(1)}"')
    except Exception:
        return ""


def _douyin(url: str) -> dict:
    try:
        page = _get(url)
    except Exception:
        return {"text": "", "video_url": None}
    text = _jstr(re.search(r'"desc":"((?:[^"\\]|\\.)*)"', page))  # 分享页内嵌 JSON 的文案字段
    video_url = _jstr(re.search(r'"play_addr":\{"uri":"[^"]*","url_list":\["((?:[^"\\]|\\.)*)"', page)) or None
    if video_url:
        # play_addr 是个中间跳转网关（playwm），doubao 服务器自己连过去经常超时（实测证实）——
        # 必须在这里跟到最终 CDN 签名直链。小红书/B站的地址本来就是最终直链，不需要这一步
        # （且它们的 CDN 认 Referer，这里跟的是无差别 UA，硬套会把好地址搞坏，之前踩过一次）。
        try:
            video_url = _resolve_redirect(video_url)
        except Exception:
            video_url = None
    return {"text": text, "video_url": video_url}


def _xiaohongshu(url: str) -> dict:
    """explore 链接必须带 xsec_token（分享链接天然带），过期/缺失会拿到空壳页。"""
    try:
        page = _get(url)
    except Exception:
        return {"text": "", "video_url": None}
    m = re.search(r"window\.__INITIAL_STATE__=(.*?)</script>", page, re.S)
    if not m:
        return {"text": "", "video_url": None}
    blob = m.group(1)
    title = _jstr(re.search(r'"title":"((?:[^"\\]|\\.)*)"', blob))
    desc = _jstr(re.search(r'"desc":"((?:[^"\\]|\\.)*)"', blob))
    text = "\n".join(t for t in (title, desc) if t).strip()
    video_url = _jstr(re.search(r'"masterUrl":"((?:[^"\\]|\\.)*)"', blob)) or None
    return {"text": text, "video_url": video_url}


def _bilibili(url: str) -> dict:
    m = re.search(r"BV[0-9A-Za-z]{10}", url)
    if not m:
        return {"text": "", "video_url": None}
    bvid = m.group()
    try:
        info = json.loads(_get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
                                ua=_UA_DESKTOP, referer="https://www.bilibili.com/"))
    except Exception:
        return {"text": "", "video_url": None}
    if info.get("code") != 0:
        return {"text": "", "video_url": None}
    d = info["data"]
    text = "\n".join(s for s in (d.get("title", ""), d.get("desc", "")) if s).strip()
    video_url = None
    cid = d.get("cid")
    if cid:
        try:
            play = json.loads(_get(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=32&fnval=1",
                                    ua=_UA_DESKTOP, referer="https://www.bilibili.com/"))
            durl = play.get("data", {}).get("durl", [])
            video_url = durl[0]["url"] if durl else None
        except Exception:
            pass
    return {"text": text, "video_url": video_url}


def _generic(url: str) -> dict:
    """通用兜底：og 标签/title。会被 WAF 拦的平台（如知乎）大概率这里也拿不到，
    交回上层判定「文案不够长」→ 诚实报错，不硬编。"""
    try:
        page = _get(url)
    except Exception:
        return {"text": "", "video_url": None}
    texts: list[str] = []
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
    return {"text": "\n".join(out).strip(), "video_url": None}


_FETCHERS = {"douyin": _douyin, "xiaohongshu": _xiaohongshu, "bilibili": _bilibili}


def fetch(url: str) -> dict:
    """统一入口：{text, video_url, platform}。video_url 拿不到就是 None——
    上层据此决定要不要露出「看视频再试一次」这个可选按钮，不是默认路径。

    要不要跟重定向、要不要带 Referer，各平台的最终直链要求不一样，由各自的
    _FETCHERS 函数自己处理好再返回——这里不做任何统一的后处理（踩过坑：曾在这里
    统一跟一次重定向，结果把 B站已经是最终直链的地址用无 Referer 的请求连坏了）。"""
    platform = detect_platform(url)
    result = _FETCHERS.get(platform, _generic)(url)
    return {**result, "platform": platform}
