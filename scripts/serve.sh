#!/bin/bash
# 生产模式：构建前端后由后端统一服务 :18100
cd "$(dirname "$0")/.."
(cd web && npm run build)
exec .venv/bin/uvicorn server.app:app --host 0.0.0.0 --port 18100
