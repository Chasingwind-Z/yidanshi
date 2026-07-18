#!/bin/bash
# 开发模式：后端 :18100 + 前端热更新 :5173（浏览器开 5173）
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
.venv/bin/uvicorn server.app:app --port 18100 --reload &
cd web && npm run dev
