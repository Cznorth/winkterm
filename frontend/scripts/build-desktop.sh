#!/usr/bin/env bash
# 桌面静态构建：临时移走 .env.local，避免把 localhost:8000 打进包内
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_LOCAL=".env.local"
BAK=".env.local.build-bak"
cleanup() {
  if [[ -f "$BAK" ]]; then
    mv -f "$BAK" "$ENV_LOCAL"
  fi
}
trap cleanup EXIT
if [[ -f "$ENV_LOCAL" ]]; then
  mv "$ENV_LOCAL" "$BAK"
fi
unset NEXT_PUBLIC_API_URL NEXT_PUBLIC_WS_URL
exec npx next build
