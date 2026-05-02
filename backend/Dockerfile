FROM python:3.12-slim

WORKDIR /app

# 使用阿里云 apt 镜像源
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# 使用清华 pip 镜像源
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

# 复制 backend 目录到 /app/backend，确保模块路径正确
COPY . /app/backend/

EXPOSE 8000

# 设置 PYTHONPATH 并从项目根目录运行
ENV PYTHONPATH=/app
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
