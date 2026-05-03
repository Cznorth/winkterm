# 阶段1: 构建前端
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
# 预安装 SWC 二进制文件（Linux x64 musl）
RUN npm install --no-save @next/swc-linux-x64-musl

COPY frontend/ .
# 切换到 export 模式（确保输出到 out/）
RUN sed -i "s/output: 'export'/output: 'export'/" next.config.mjs || true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 阶段2: 构建后端
FROM python:3.12-slim

WORKDIR /app

# 使用阿里云 apt 镜像源
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
# 使用清华 pip 镜像源
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

# 复制 backend 代码
COPY backend/ /app/backend/

# 复制前端构建产物
COPY --from=frontend-builder /frontend/out /app/frontend/out

EXPOSE 8000

ENV PYTHONPATH=/app
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
