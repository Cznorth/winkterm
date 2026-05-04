from __future__ import annotations

import logging
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

# Check if running in PyInstaller bundle
IS_FROZEN = getattr(sys, 'frozen', False)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Logging: suppress noisy third-party debug logs
    logging.getLogger("anthropic").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.INFO)
    logging.getLogger("openai").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    print("=" * 50)
    print("  WinkTerm Backend starting...")
    print(f"  LLM URL     : {settings.effective_base_url}")
    print(f"  LLM Model   : {settings.effective_model}")
    print(f"  API key set : {'yes' if settings.effective_api_key else 'NO - please set API key'}")
    print(f"  Loki        : {settings.loki_url}")
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

# Mount routes
app.include_router(http_router, prefix="/api", tags=["analysis"])
app.include_router(ws_router, prefix="/ws", tags=["terminal"])
app.include_router(ssh_router, tags=["ssh"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.post("/exit")
async def exit_app():
    """Graceful exit for desktop mode."""
    import os
    import threading

    def do_exit():
        import time
        time.sleep(0.1)
        os._exit(0)
    threading.Thread(target=do_exit, daemon=True).start()
    return {"status": "exiting"}


# Static file serving (desktop mode)
def get_static_dir() -> Path | None:
    """Get frontend static files directory."""
    if IS_FROZEN:
        base = Path(sys._MEIPASS)
        static_dir = base / "frontend_static"
    else:
        static_dir = Path(__file__).parent.parent / "frontend" / "out"

    if static_dir.exists() and (static_dir / "index.html").exists():
        return static_dir
    return None


_static_dir = get_static_dir()
if _static_dir:
    next_dir = _static_dir / "_next"
    if next_dir.exists():
        app.mount("/_next", StaticFiles(directory=str(next_dir)), name="next-static")

    from fastapi import Request
    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        """SPA fallback: serve index.html for all unmatched routes."""
        file_path = _static_dir / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_static_dir / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
