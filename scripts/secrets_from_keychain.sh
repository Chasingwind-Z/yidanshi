#!/bin/bash
# 从 macOS 登录钥匙串重建 data/secrets.env（secrets.env 丢失/换机后用）。
# 只会写回钥匙串里存在的项；不覆盖已有非密钥内容以外的东西。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/secrets.env"
KEYS="ARK_API_KEY DEEPSEEK_API_KEY ALIYUN_AK_ID ALIYUN_AK_SECRET COS_SECRET_ID COS_SECRET_KEY COS_REGION COS_BUCKET YIDANSHI_TOKEN SERVERCHAN_SENDKEY"
mkdir -p "$ROOT/data"
{
  echo "# 一箪食密钥（从 macOS 钥匙串恢复于 $(date +%F)）"
  echo "# 编辑后运行 scripts/secrets_to_keychain.sh 可回写钥匙串"
  for k in $KEYS; do
    v=$(security find-generic-password -a "$USER" -s "yidanshi.$k" -w 2>/dev/null || true)
    [ -n "$v" ] && echo "$k=$v"
  done
} > "$OUT"
chmod 600 "$OUT"
echo "已恢复 $OUT（$(grep -c '=' "$OUT" 2>/dev/null || echo 0) 项）"
