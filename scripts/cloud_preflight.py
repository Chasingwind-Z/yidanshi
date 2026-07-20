#!/usr/bin/env python3
"""一箪食 · 云托管部署自检 (cloud preflight)

配好云凭证后跑一条命令，逐项探测 R18 每样云服务通没通：
    python3 scripts/cloud_preflight.py

检查项：DeepSeek(v4-flash) · 阿里云 SegmentFood 抠图 · 腾讯云 COS · MySQL · 本地 Web。
每项输出 ✓ 通 / ✗ 不通 / ⚠ 通了但要处理 / ⊝ 未配置跳过，最后给一句话总结与指引。

安全承诺（务必信守）：
  * 只做「读」探测——GET/HEAD/SELECT 1，绝不上传、写入、删除任何云端资源。
  * 绝不打印任何密钥值。凡要回显 API 报文，都先把已知密钥值替换成 ***。
  * 什么都没配也能干净跑完（全部 ⊝ + 指引），不报错、不崩。

凭证来源：data/secrets.env + 环境变量（环境变量优先，与 server/app.py 的 setdefault 语义一致）。
纯标准库实现；只有 MySQL 检查用到 pymysql，缺库则跳过并提示 pip 装法。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("YIDANSHI_DATA_DIR", "").strip() or (ROOT / "data"))
SECRETS_FILE = DATA / "secrets.env"

# ---------- 凭证加载（不打印任何值） ----------

def _load_secrets_file() -> dict[str, str]:
    """按 server/app.py 的口径解析 data/secrets.env：KEY=value，# 注释，两侧去空白。"""
    out: dict[str, str] = {}
    if not SECRETS_FILE.exists():
        return out
    for line in SECRETS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


_FILE_CREDS = _load_secrets_file()


def cred(key: str) -> str:
    """生效凭证：环境变量优先，缺席时回落 secrets.env（与 app.py setdefault 等价）。"""
    return (os.environ.get(key) or _FILE_CREDS.get(key) or "").strip()


# 收集所有已知密钥值，用于对外输出前脱敏
_SECRET_VALUES = sorted(
    {v for v in list(_FILE_CREDS.values()) + [os.environ.get(k, "") for k in _FILE_CREDS]
     if v and len(v) >= 6},
    key=len, reverse=True,  # 先替换长的，避免子串误伤
)


def redact(text: str) -> str:
    """把任何已知密钥值从字符串里抹成 ***。防止 API 报文意外回显凭证。"""
    s = str(text)
    for v in _SECRET_VALUES:
        if v in s:
            s = s.replace(v, "***")
    return s


# ---------- 输出 ----------

_TTY = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text


# 每项检查回一个状态；PASS/FAIL/WARN/SKIP
PASS, FAIL, WARN, SKIP = "PASS", "FAIL", "WARN", "SKIP"
_MARK = {
    PASS: (_c("32", "✓"), _c("32", "通")),
    FAIL: (_c("31", "✗"), _c("31", "不通")),
    WARN: (_c("33", "⚠"), _c("33", "注意")),
    SKIP: (_c("90", "⊝"), _c("90", "跳过")),
}


def line(status: str, name: str, detail: str = "") -> None:
    mark, _ = _MARK[status]
    head = f" {mark} {name:<16}"
    print(f"{head} {redact(detail)}" if detail else head)


def note(text: str) -> None:
    print(f"      {_c('90', redact(text))}")


# ---------- HTTP 小工具（纯 urllib） ----------

def http(method: str, url: str, headers: dict | None = None, timeout: float = 15):
    """发一个请求，返回 (status, body_text)。任何非 2xx 也回而不抛（HTTPError 带 body）。
    网络层错误（超时/连不上/DNS）抛出，由调用方转成 ✗。"""
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        return e.code, body


# ---------- ① DeepSeek ----------

def check_deepseek() -> str:
    key = cred("DEEPSEEK_API_KEY")
    if not key:
        line(SKIP, "DeepSeek", "未配置 DEEPSEEK_API_KEY")
        note("云端无 claude/codex CLI 时靠它做 AI 整理；去 https://platform.deepseek.com 拿 key")
        return SKIP

    auth = {"Authorization": f"Bearer {key}"}
    try:
        status, body = http("GET", "https://api.deepseek.com/models", auth)
    except Exception as e:
        line(FAIL, "DeepSeek", f"请求失败：{e}")
        return FAIL

    if status == 401:
        line(FAIL, "DeepSeek", "401 鉴权失败：DEEPSEEK_API_KEY 无效")
        return FAIL
    if status != 200:
        line(FAIL, "DeepSeek", f"HTTP {status}：{body[:120]}")
        return FAIL

    try:
        ids = [m.get("id", "") for m in json.loads(body).get("data", [])]
    except Exception:
        ids = []

    result = PASS
    if "deepseek-v4-flash" in ids:
        line(PASS, "DeepSeek", "key 有效，deepseek-v4-flash 可用")
    else:
        line(WARN, "DeepSeek", "key 有效，但模型列表里没有 deepseek-v4-flash")
        note(f"当前可用模型：{', '.join(ids) or '(空)'}；契约要求 deepseek-v4-flash（deepseek-chat 已下线）")
        result = WARN

    # 顺带打余额（失败不影响结论）
    try:
        bstatus, bbody = http("GET", "https://api.deepseek.com/user/balance", auth)
        if bstatus == 200:
            info = json.loads(bbody)
            avail = info.get("is_available")
            bals = info.get("balance_infos") or []
            if bals:
                b = bals[0]
                note(f"余额：{b.get('total_balance')} {b.get('currency')}"
                     + ("" if avail else "（账户当前不可用，请检查充值）"))
            else:
                note(f"余额接口可用（is_available={avail}）")
    except Exception:
        pass
    return result


# ---------- ② 阿里云 SegmentFood（RPC HMAC-SHA1 手签） ----------

def _aliyun_pe(s: str) -> str:
    # RFC3986：Python quote 天然不编码 _.-~，其余（含空格→%20、*→%2A）都编码
    return urllib.parse.quote(str(s), safe="")


def check_aliyun() -> str:
    ak_id, ak_secret = cred("ALIYUN_AK_ID"), cred("ALIYUN_AK_SECRET")
    if not (ak_id and ak_secret):
        line(SKIP, "阿里云 SegmentFood", "未配置 ALIYUN_AK_ID / ALIYUN_AK_SECRET")
        note("云端抠图（rembg 不进云镜像）靠它；去 https://ram.console.aliyun.com 建 AccessKey")
        return SKIP

    endpoint = os.environ.get("ALIYUN_IMAGESEG_ENDPOINT", "imageseg.cn-shanghai.aliyuncs.com").strip()
    params = {
        "Action": "SegmentFood",
        "Version": "2019-12-30",
        "Format": "JSON",
        "AccessKeyId": ak_id,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": uuid.uuid4().hex,
        "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "RegionId": "cn-shanghai",
        # 故意给一个不存在的图片地址：AK 若有效且已授权，只会栽在「图片层面」的错，即视为通
        "ImageURL": "https://yidanshi-preflight.invalid/none.jpg",
    }
    canonical = "&".join(f"{_aliyun_pe(k)}={_aliyun_pe(params[k])}" for k in sorted(params))
    string_to_sign = f"GET&{_aliyun_pe('/')}&{_aliyun_pe(canonical)}"
    sig = base64.b64encode(
        hmac.new((ak_secret + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    query = canonical + "&Signature=" + _aliyun_pe(sig)
    url = f"https://{endpoint}/?{query}"

    try:
        status, body = http("GET", url)
    except Exception as e:
        line(FAIL, "阿里云 SegmentFood", f"请求失败：{e}")
        return FAIL

    try:
        code = json.loads(body).get("Code", "")
    except Exception:
        code = ""
    low = (code or body).lower()

    if status == 200:
        line(PASS, "阿里云 SegmentFood", "AK 有效且已授权（接口正常返回）")
        return PASS
    if "invalidaccesskeyid" in low or "signaturedoesnotmatch" in low:
        line(FAIL, "阿里云 SegmentFood", f"AK 错误：{code or body[:120]}")
        note("ALIYUN_AK_ID/ALIYUN_AK_SECRET 填错或已停用，去 RAM 控制台核对")
        return FAIL
    if any(w in low for w in ("forbidden", "unauthorized", "nopermission", "notauthorized", "sts.")):
        line(WARN, "阿里云 SegmentFood", f"AK 对，但没权限：{code}")
        note("去 RAM 给该 AK 的用户加 AliyunVIAPIFullAccess 授权，再重跑本检查")
        return WARN
    # 到这里通常是图片层面的错（下载失败/图片非法等）——正说明签名与授权都过了
    line(PASS, "阿里云 SegmentFood", f"AK 有效且已授权（图片层错误属预期）：{code or body[:80]}")
    return PASS


# ---------- ③ 腾讯云 COS（XML API 签名 v5 手签，只读 HEAD/GET） ----------

def _cos_kv(d: dict) -> tuple[str, str]:
    items = sorted((urllib.parse.quote(str(k).lower(), safe=""),
                    urllib.parse.quote(str(v), safe="")) for k, v in d.items())
    return ";".join(k for k, _ in items), "&".join(f"{k}={v}" for k, v in items)


def check_cos() -> str:
    want = ("COS_SECRET_ID", "COS_SECRET_KEY", "COS_REGION", "COS_BUCKET")
    vals = {k: cred(k) for k in want}
    have = [k for k in want if vals[k]]
    if not have:
        line(SKIP, "腾讯云 COS", "未配置 COS_SECRET_ID/KEY/REGION/BUCKET")
        note("照片存云端靠它；未配则照片存本地。桶要开公有读，前端 downloadFile 才能拉图")
        return SKIP
    if len(have) < len(want):
        missing = [k for k in want if not vals[k]]
        line(WARN, "腾讯云 COS", f"只配了一部分，缺：{', '.join(missing)}")
        note("四个变量要么全配、要么全不配（缺一即回落本地存储）")
        return WARN

    secret_id, secret_key = vals["COS_SECRET_ID"], vals["COS_SECRET_KEY"]
    region, bucket = vals["COS_REGION"], vals["COS_BUCKET"]
    host = f"{bucket}.cos.{region}.myqcloud.com"

    method, path, q_params = "get", "/", {"max-keys": "1"}  # 只列 1 个对象，纯只读
    headers = {"host": host}
    now = int(time.time())
    key_time = f"{now};{now + 300}"
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    url_param_list, http_params = _cos_kv(q_params)
    header_list, http_headers = _cos_kv(headers)
    http_string = f"{method}\n{path}\n{http_params}\n{http_headers}\n"
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    authorization = (
        f"q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}"
        f"&q-key-time={key_time}&q-header-list={header_list}"
        f"&q-url-param-list={url_param_list}&q-signature={signature}"
    )
    url = f"https://{host}/?max-keys=1"

    try:
        status, body = http("GET", url, {"Authorization": authorization, "Host": host})
    except Exception as e:
        line(FAIL, "腾讯云 COS", f"请求失败（地域/桶名是否正确？）：{e}")
        return FAIL

    import re
    m = re.search(r"<Code>(.*?)</Code>", body)
    xcode = m.group(1) if m else ""

    if status == 200:
        line(PASS, "腾讯云 COS", f"桶 {bucket} 可读（HTTP 200）")
        note("提醒：确认桶的「访问权限」已设为公有读，否则小程序拉照片会 403")
        return PASS
    if status == 403:
        line(FAIL, "腾讯云 COS", f"403：密钥或权限问题（{xcode or 'AccessDenied'}）")
        note("检查 COS_SECRET_ID/KEY 是否正确、该子账号是否有此桶的读权限")
        return FAIL
    if status == 404:
        line(FAIL, "腾讯云 COS", f"404：桶名或地域错（{xcode or 'NoSuchBucket'}）")
        note(f"当前 COS_BUCKET={bucket}、COS_REGION={region}，去 COS 控制台核对（桶名含 appid 后缀）")
        return FAIL
    line(FAIL, "腾讯云 COS", f"HTTP {status}：{xcode or body[:100]}")
    return FAIL


# ---------- ④ MySQL（可选，懒 import pymysql） ----------

def check_mysql() -> str:
    db_url = cred("YIDANSHI_DB_URL")
    addr = cred("MYSQL_ADDRESS")
    if not (db_url or addr):
        line(SKIP, "MySQL", "本地未配置（YIDANSHI_DB_URL / MYSQL_ADDRESS 均空）")
        note("云上由云托管 MySQL 插件自动注入 MYSQL_* 变量，本地无需配置")
        return SKIP

    try:
        import pymysql  # noqa: F401
    except ImportError:
        line(SKIP, "MySQL", "已配置连接串，但本机没装 pymysql")
        note("装：python3 -m pip install pymysql（或用项目 .venv）")
        return SKIP

    # 解析连接参数
    if db_url:
        u = urllib.parse.urlparse(db_url.replace("mysql+pymysql://", "mysql://"))
        conn_kw = dict(host=u.hostname or "127.0.0.1", port=u.port or 3306,
                       user=urllib.parse.unquote(u.username or "root"),
                       password=urllib.parse.unquote(u.password or ""),
                       database=(u.path.lstrip("/") or None))
    else:
        host, _, port = addr.partition(":")
        conn_kw = dict(host=host or "127.0.0.1", port=int(port or 3306),
                       user=cred("MYSQL_USERNAME") or "root",
                       password=cred("MYSQL_PASSWORD"), database=None)

    try:
        conn = pymysql.connect(connect_timeout=8, **conn_kw)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        finally:
            conn.close()
    except Exception as e:
        line(FAIL, "MySQL", f"连接失败：{type(e).__name__}: {str(e)[:120]}")
        return FAIL
    line(PASS, "MySQL", f"SELECT 1 成功（{conn_kw['host']}:{conn_kw['port']}）")
    return PASS


# ---------- ⑤ 本地 Web（与云部署无关，仅确认现状服务活着） ----------

def check_local() -> str:
    port = os.environ.get("PORT", "18100").strip() or "18100"
    url = f"http://127.0.0.1:{port}/api/recipes"
    try:
        status, body = http("GET", url, timeout=4)
    except Exception:
        line(SKIP, "本地 Web", f"{url} 未连通")
        note("这是本地自用服务，与云托管部署无关；要起本地服务跑 ./scripts/manage.sh restart")
        return SKIP
    if status == 200:
        try:
            n = len(json.loads(body))
            extra = f"（{n} 道菜谱）"
        except Exception:
            extra = ""
        line(PASS, "本地 Web", f"{url} 200{extra}")
        note("提醒：本地 Web 与云部署互不影响，云端另跑一套容器")
        return PASS
    line(WARN, "本地 Web", f"{url} 返回 HTTP {status}")
    return WARN


# ---------- 主流程 ----------

CHECKS = [
    ("DeepSeek AI 整理", check_deepseek),
    ("阿里云 SegmentFood 抠图", check_aliyun),
    ("腾讯云 COS 照片存储", check_cos),
    ("MySQL 数据库", check_mysql),
    ("本地 Web 服务", check_local),
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="一箪食云托管部署自检：逐项探测各云服务是否连通。"
                    "只读探测，绝不写云端资源，绝不打印任何密钥值。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="凭证来源：data/secrets.env + 环境变量（环境变量优先）。\n"
               "什么都没配也能干净跑完（全部 ⊝ 跳过 + 指引）。",
    )
    parser.parse_args()

    print(_c("1", "\n一箪食 · 云托管部署自检"))
    if SECRETS_FILE.exists():
        print(_c("90", f"凭证：{SECRETS_FILE}（值不外显）+ 环境变量"))
    else:
        print(_c("90", f"未找到 {SECRETS_FILE}，仅读环境变量"))
    legend = f"图例  {_MARK[PASS][0]} 通   {_MARK[FAIL][0]} 不通   {_MARK[WARN][0]} 需处理   {_MARK[SKIP][0]} 未配置跳过"
    print(_c("90", legend))
    print(_c("90", "─" * 56))

    results: dict[str, str] = {}
    for title, fn in CHECKS:
        try:
            results[title] = fn()
        except Exception as e:  # 任何单项内部异常都不许拖垮整体
            line(FAIL, title.split()[0], f"检查器内部异常：{type(e).__name__}: {e}")
            results[title] = FAIL
        print()

    # ---- 总结 ----
    print(_c("90", "─" * 56))
    tally = {s: sum(1 for v in results.values() if v == s) for s in (PASS, WARN, FAIL, SKIP)}
    summary = (f"{_c('32', str(tally[PASS]) + ' 通')}  "
               f"{_c('33', str(tally[WARN]) + ' 需处理')}  "
               f"{_c('31', str(tally[FAIL]) + ' 不通')}  "
               f"{_c('90', str(tally[SKIP]) + ' 未配置')}")
    print("总结  " + summary)

    if tally[FAIL]:
        print(_c("31", "有服务不通——上线前请照上面每项的指引修好。"))
    elif tally[WARN]:
        print(_c("33", "基本就绪，但有项需处理（多为授权/权限），照指引补上即可。"))
    elif tally[PASS] == 0:
        print(_c("90", "还没配任何云凭证。照 docs/deploy.md 配好后再跑本检查。"))
    else:
        print(_c("32", "已配置项全部连通。可照 docs/deploy.md 继续部署。"))
    print(_c("90", "详细部署步骤见 docs/deploy.md\n"))

    return 1 if tally[FAIL] else 0


if __name__ == "__main__":
    sys.exit(main())
