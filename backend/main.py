from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings
from backend.api.routes import router as http_router
from backend.api.ws_routes import router as ws_router
from backend.api.ssh_routes import router as ssh_router

# 判断是否在打包环境
IS_FROZEN = getattr(sys, 'frozen', False)


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
app.include_router(ssh_router, tags=["ssh"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


# 静态文件服务（桌面模式）
def get_static_dir() -> Path | None:
    """获取前端静态文件目录"""
    if IS_FROZEN:
        # PyInstaller 打包后的路径
        base = Path(sys._MEIPASS)
        static_dir = base / "frontend_static"
    else:
        # 开发模式：检查 frontend/out 是否存在
        static_dir = Path(__file__).parent.parent / "frontend" / "out"

    if static_dir.exists() and (static_dir / "index.html").exists():
        return static_dir
    return None


_static_dir = get_static_dir()
if _static_dir:
    # 挂载 _next 静态资源
    next_dir = _static_dir / "_next"
    if next_dir.exists():
        app.mount("/_next", StaticFiles(directory=str(next_dir)), name="next-static")

    # SPA fallback：所有未匹配的路由返回 index.html
    from fastapi import Request
    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        """SPA 路由 fallback"""
        # 检查是否请求的是具体文件
        file_path = _static_dir / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        # 否则返回 index.html（SPA 路由）
        return FileResponse(_static_dir / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
