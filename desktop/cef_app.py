"""CEF Python 桌面应用 - 无边框窗口"""
from __future__ import annotations

import logging
import sys
import threading
import time
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# 判断运行环境
IS_FROZEN = getattr(sys, "frozen", False)


def get_cef_paths():
    """获取 CEF 文件路径"""
    if IS_FROZEN:
        # PyInstaller 打包后
        base_path = Path(sys._MEIPASS)
    else:
        # 开发模式
        base_path = Path(__file__).parent.parent / ".venv" / "Lib" / "site-packages" / "cefpython3"

    return {
        "base_path": str(base_path),
        "browser_subprocess_path": str(base_path / "subprocess.exe") if IS_FROZEN else str(base_path / "subprocess.exe"),
        "resources_dir_path": str(base_path),
        "locales_dir_path": str(base_path / "locales"),
    }


def run_desktop_app(host: str, port: int, width: int, height: int):
    """启动桌面应用"""
    from cefpython3 import cefpython as cef
    import ctypes
    import platform

    url = f"http://{host}:{port}"

    # 获取 CEF 路径
    cef_paths = get_cef_paths()

    # 初始化 CEF
    settings = {
        "browser_subprocess_path": cef_paths["browser_subprocess_path"],
        "resources_dir_path": cef_paths["resources_dir_path"],
        "locales_dir_path": cef_paths["locales_dir_path"],
        "context_menu": {"enabled": False},
        "downloads": {"enabled": False},
        "log_severity": cef.LOGSEVERITY_WARNING,
        "remote_debugging_port": 0,
    }

    switches = {
        "disable-gpu": "",
        "disable-gpu-compositing": "",
        "enable-begin-frame-scheduling": "",
    }

    cef.Initialize(settings=settings, switches=switches)

    # 创建浏览器窗口
    window_info = cef.WindowInfo()
    window_info.SetAsWindowed(0, "WinkTerm")

    browser_settings = {
        "file_access_from_file_urls": cef.STATE_ENABLED,
        "universal_access_from_file_urls": cef.STATE_ENABLED,
    }

    # 创建浏览器
    browser = cef.CreateBrowserSync(
        window_info=window_info,
        url=url,
        settings=browser_settings,
    )

    # 获取窗口句柄并设置窗口属性
    hwnd = browser.GetWindowHandle()

    if platform.system() == "Windows":
        user32 = ctypes.windll.user32

        # 设置窗口位置和大小
        SWP_SHOWWINDOW = 0x0040
        user32.SetWindowPos(hwnd, 0, 100, 100, width, height, SWP_SHOWWINDOW)

        # 无边框窗口样式
        GWL_STYLE = -16
        GWL_EXSTYLE = -20

        WS_POPUP = 0x80000000
        WS_THICKFRAME = 0x00040000
        WS_MINIMIZEBOX = 0x00020000
        WS_MAXIMIZEBOX = 0x00010000
        WS_SYSMENU = 0x00080000
        WS_VISIBLE = 0x10000000

        # 设置窗口样式（保留边框可调整大小，无标题栏）
        style = WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_VISIBLE
        user32.SetWindowLongW(hwnd, GWL_STYLE, style)

        # 设置扩展样式
        WS_EX_APPWINDOW = 0x00040000
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, WS_EX_APPWINDOW)

        # 使窗口重绘
        SWP_FRAMECHANGED = 0x0020
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_NOZORDER = 0x0004
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                           SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW)

    logger.info(f"Desktop app started: {url}")

    # 消息循环
    cef.MessageLoop()

    # 清理
    cef.Shutdown()


def start_backend(host: str, port: int):
    """启动后端服务"""
    import uvicorn
    from backend.main import app

    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)

    uvicorn.run(app, host=host, port=port, log_level="warning")


def main():
    import argparse
    import httpx

    parser = argparse.ArgumentParser(description="WinkTerm Desktop")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--width", type=int, default=1400)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--headless", action="store_true", help="服务器模式（无窗口）")
    args = parser.parse_args()

    if args.headless:
        # 服务器模式：直接运行后端
        start_backend(args.host, args.port)
    else:
        # 桌面模式：先启动后端线程，再启动 GUI
        url = f"http://{args.host}:{args.port}"

        # 启动后端
        logger.info("Starting backend server...")
        backend_thread = threading.Thread(
            target=start_backend,
            args=(args.host, args.port),
            daemon=True,
        )
        backend_thread.start()

        # 等待后端就绪
        logger.info("Waiting for server...")
        for _ in range(50):
            try:
                resp = httpx.get(f"{url}/health", timeout=0.5)
                if resp.status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            logger.error("Backend failed to start")
            sys.exit(1)

        logger.info(f"Server ready at {url}")

        # 启动桌面应用
        run_desktop_app(args.host, args.port, args.width, args.height)


if __name__ == "__main__":
    main()
