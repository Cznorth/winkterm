#!/bin/bash
# Docker 部署构建脚本

set -e

echo "=== 构建前端静态文件 ==="
cd frontend
npm install
npm run build
cd ..

echo "=== 启动 Docker 服务 ==="
docker compose up -d --build

echo "=== 完成 ==="
echo "访问: http://localhost:8000"
