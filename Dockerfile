# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
# Pre-install SWC binary for Linux x64 musl
RUN npm install --no-save @next/swc-linux-x64-musl

COPY frontend/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2: Build backend
FROM python:3.12-slim

WORKDIR /app

# Use Aliyun apt mirror
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (Tsinghua mirror)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

# Copy backend code
COPY backend/ /app/backend/

# Copy frontend build output
COPY --from=frontend-builder /frontend/out /app/frontend/out

EXPOSE 8000

ENV PYTHONPATH=/app
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
