#!/bin/bash
# 一箪食服务管理：install / uninstall / restart / status / log / backup
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.zzf.yidanshi"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
  install)
    (cd "$ROOT/web" && npm run build)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    sed -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$ROOT/deploy/$LABEL.plist" > "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "已安装并启动：http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):18100"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已停止并移除服务"
    ;;
  restart)
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "已重启"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "未运行"
    curl -sf localhost:18100/api/recipes >/dev/null && echo "API 正常" || echo "API 无响应"
    ;;
  log)
    tail -f "$HOME/Library/Logs/yidanshi.log"
    ;;
  backup)
    mkdir -p "$HOME/Backups"
    OUT="$HOME/Backups/yidanshi-data-$(date +%Y%m%d).tar.gz"
    tar czf "$OUT" -C "$ROOT" data
    echo "已备份到 $OUT"
    ;;
  *)
    echo "用法：$0 {install|uninstall|restart|status|log|backup}"
    ;;
esac
