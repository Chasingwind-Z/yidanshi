#!/bin/bash
# 把 data/secrets.env 里的密钥加密备份进 macOS 登录钥匙串。
# 钥匙串随开机登录自动解锁、静态加密，无需额外密码；secrets.env 丢了可用
# secrets_from_keychain.sh 一键恢复。本脚本不含任何密钥值，可安全提交。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/data/secrets.env"
[ -f "$ENV" ] || { echo "找不到 $ENV"; exit 1; }
n=0
while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z_]+$ ]] || continue      # 跳过注释/空行
  [ -z "$v" ] && continue
  # -U 覆盖更新；service 名统一加 yidanshi. 前缀，避免与其它钥匙串项冲突
  security add-generic-password -a "$USER" -s "yidanshi.$k" -w "$v" -U >/dev/null
  echo "  ✓ 已加密备份 $k"
  n=$((n+1))
done < "$ENV"
echo "完成：$n 个密钥已存入钥匙串（service 前缀 yidanshi.）。恢复：scripts/secrets_from_keychain.sh"
