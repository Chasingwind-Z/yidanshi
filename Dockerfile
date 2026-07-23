# 一箪食 · 微信云托管镜像（服务名 yidanshi）
# 云上数据在 MySQL/COS，镜像不带 data/（见 .dockerignore）；本地 Web 部署不用这个文件。
FROM python:3.11-slim

WORKDIR /app

# 中文字体：容器裸奔时 PIL 渲染教程卡/长图/月结卡全是豆腐块（真机实测）。
# Noto Serif CJK（思源宋体）路径与 monthcard._font 回退链吻合；apt 走腾讯镜像
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-cjk-extra \
    && rm -rf /var/lib/apt/lists/*

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
