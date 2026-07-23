# 一箪食 · 微信云托管镜像（服务名 yidanshi）
# 云上数据在 MySQL/COS，镜像不带 data/（见 .dockerignore）；本地 Web 部署不用这个文件。
FROM python:3.11-slim

WORKDIR /app

# 中文字体走仓库自带的思源宋 SC（server/assets/fonts/，OFL 许可）——曾用 apt 装
# fonts-noto-cjk：200MB 拖慢每次构建且镜像抖动会整次失败，已弃用

# 依赖层单独 COPY，代码改动不重装依赖；腾讯镜像源（云托管构建机在腾讯云内，公网也可用）
COPY server/requirements-cloud.txt server/requirements-cloud.txt
RUN pip install --no-cache-dir -r server/requirements-cloud.txt \
    -i https://mirrors.cloud.tencent.com/pypi/simple

COPY server ./server
COPY examples ./examples

# 文件兜底路径要存在（COS/MySQL 未配时照片与文档写本地；容器重启即失，仅兜底不当持久层）
RUN mkdir -p data

ENV PORT=80
EXPOSE 80

CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-80}"]
