FROM python:3.12-slim

# Inject sandbox proxy CA cert
COPY sandbox-ca.crt /usr/local/share/ca-certificates/sandbox-ca.crt
RUN update-ca-certificates

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org \
    -r requirements.txt

COPY backend/ /app/backend/
COPY frontend/out /app/frontend/out

EXPOSE 8000

ENV PYTHONPATH=/app
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
