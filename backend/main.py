from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.api.routes import router as http_router
from backend.api.ws_routes import router as ws_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    print("=" * 50)
    print("  WinkTerm Backend starting...")
    print(f"  Model       : {settings.llm_model}")
    print(f"  LLM URL     : {settings.llm_base_url}")
    print(f"  Prometheus  : {settings.prometheus_url}")
    print(f"  Loki        : {settings.loki_url}")
    print(f"  CORS origins: {settings.cors_origins}")
    print(f"  API key set : {'yes' if settings.llm_api_key else 'NO - please set LLM_API_KEY'}")
    print("=" * 50)
    yield
    print("WinkTerm Backend stopped.")


app = FastAPI(
    title="WinkTerm API",
    description="AI + Terminal human-machine unified operations tool",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载路由
app.include_router(http_router, prefix="/api", tags=["analysis"])
app.include_router(ws_router, prefix="/ws", tags=["terminal"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
