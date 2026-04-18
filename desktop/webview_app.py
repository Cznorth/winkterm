"""WebView 桌面应用 - 无边框窗口 + 自定义标题栏"""
from __future__ import annotations

import logging
import socket
import sys
import threading
import time
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# 判断运行环境
IS_FROZEN = getattr(sys, "frozen", False)
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# 全局状态
_window = None
_is_maximized = False
_is_fullscreen = False
_saved_rect = None

# Windows API 常量和导入
if IS_WINDOWS:
    import ctypes
    SM_CXSCREEN = 0
    SM_CYSCREEN = 1
    SPI_GETWORKAREA = 0x0030
    SWP_NOZORDER = 0x0004
    SWP_SHOWWINDOW = 0x0040
    _hwnd = None


def get_work_area():
    """获取屏幕工作区大小（排除任务栏/Dock）"""
    if IS_WINDOWS:
        rect = ctypes.wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
        return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
    elif IS_MACOS:
        # macOS: 返回屏幕尺寸
        import subprocess
        try:
            result = subprocess.run(
                ["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                parts = result.stdout.strip().split(", ")
                if len(parts) == 4:
                    return int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        except Exception:
            pass
        return None
    return None


if IS_WINDOWS:
    def find_window_handle():
        """查找窗口句柄 (Windows only)"""
        global _hwnd

        if _hwnd:
            return _hwnd

        try:
            user32 = ctypes.windll.user32
            hwnd = user32.FindWindowW(None, "WinkTerm")
            if hwnd:
                _hwnd = hwnd
                return _hwnd

            EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

            def enum_callback(hwnd, _):
                global _hwnd
                length = user32.GetWindowTextLengthW(hwnd) + 1
                buffer = ctypes.create_unicode_buffer(length)
                user32.GetWindowTextW(hwnd, buffer, length)
                if "WinkTerm" in buffer.value:
                    _hwnd = hwnd
                    return False
                return True

            user32.EnumWindows(EnumWindowsProc(enum_callback), 0)

            if _hwnd:
                return _hwnd

        except Exception as e:
            logger.error(f"Error finding window: {e}")

        return None


class WindowAPI:
    """暴露给前端的窗口控制 API"""

    def minimize(self):
        """最小化窗口"""
        global _window
        if _window:
            _window.minimize()

    def maximize(self):
        """最大化窗口"""
        global _is_maximized, _saved_rect, _window

        if not _window:
            return

        # 保存当前窗口位置
        _saved_rect = (_window.x, _window.y, _window.width, _window.height)
        logger.info(f"maximize: saved_rect = {_saved_rect}")

        if IS_WINDOWS:
            hwnd = find_window_handle()
            if hwnd:
                work_x, work_y, work_w, work_h = get_work_area()
                user32 = ctypes.windll.user32
                user32.SetWindowPos(hwnd, 0, work_x, work_y, work_w, work_h, SWP_NOZORDER | SWP_SHOWWINDOW)
            else:
                work = get_work_area()
                if work:
                    _window.resize(work[2], work[3])
                    _window.move(work[0], work[1])
        elif IS_MACOS:
            # macOS: 使用系统原生全屏
            global _is_fullscreen
            if not _is_fullscreen:
                _window.toggle_fullscreen()
                _is_fullscreen = True
                return

        _is_maximized = True
        logger.info("maximize: done")

    def restore(self):
        """还原窗口"""
        global _is_maximized, _is_fullscreen, _saved_rect, _window

        if not _window:
            return

        if IS_MACOS and _is_fullscreen:
            _window.toggle_fullscreen()
            _is_fullscreen = False
            _is_maximized = False
            return

        if not _saved_rect:
            return

        if IS_WINDOWS:
            hwnd = find_window_handle()
            if hwnd:
                user32 = ctypes.windll.user32
                user32.SetWindowPos(hwnd, 0, _saved_rect[0], _saved_rect[1],
                                   _saved_rect[2], _saved_rect[3], SWP_NOZORDER | SWP_SHOWWINDOW)
            else:
                _window.resize(_saved_rect[2], _saved_rect[3])
                _window.move(_saved_rect[0], _saved_rect[1])

        _is_maximized = False
        logger.info(f"restore: restored to {_saved_rect}")

    def toggle_maximize(self):
        """切换最大化/还原"""
        global _is_maximized, _is_fullscreen
        if _is_maximized or _is_fullscreen:
            self.restore()
        else:
            self.maximize()

    def close(self):
        """关闭窗口"""
        global _window
        logger.info("close() called, exiting...")
        # 强制退出进程
        import os
        os._exit(0)

    def is_maximized(self):
        """检查窗口是否最大化"""
        global _is_maximized, _is_fullscreen
        return _is_maximized or _is_fullscreen

    def resize(self, width: int, height: int):
        """调整窗口大小"""
        global _window
        if _window:
            _window.resize(width, height)

    def move(self, x: int, y: int):
        """移动窗口"""
        global _window
        if _window:
            _window.move(x, y)

    def get_size(self):
        """获取窗口大小"""
        global _window
        if _window:
            return {"width": _window.width, "height": _window.height}
        return {"width": 1400, "height": 900}

    def get_position(self):
        """获取窗口位置"""
        global _window
        if _window:
            return {"x": _window.x, "y": _window.y}
        return {"x": 0, "y": 0}

    def get_work_area(self):
        """获取工作区大小"""
        work = get_work_area()
        if work:
            return {"x": work[0], "y": work[1], "width": work[2], "height": work[3]}
        return {"x": 0, "y": 0, "width": 1920, "height": 1080}


# 创建 API 实例
window_api = WindowAPI()


def find_free_port(start_port: int = 8000, max_attempts: int = 100) -> int:
    """查找未被占用的端口。

    Args:
        start_port: 起始端口
        max_attempts: 最大尝试次数

    Returns:
        可用的端口号
    """
    for port in range(start_port, start_port + max_attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise RuntimeError(f"无法找到可用端口 (尝试范围: {start_port}-{start_port + max_attempts})")


def run_desktop_app(host: str, port: int, width: int, height: int):
    """启动桌面应用"""
    import webview

    global _window
    url = f"http://{host}:{port}"

    _window = webview.create_window(
        title="WinkTerm",
        url=url,
        width=width,
        height=height,
        resizable=True,
        frameless=True,
        easy_drag=False,
        background_color="#1e1e1e",
        js_api=window_api,
    )

    logger.info(f"Desktop app started: {url}")
    webview.start(debug=True)


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
    parser.add_argument("--port", type=int, default=None, help="指定端口，默认自动分配")
    parser.add_argument("--width", type=int, default=1400)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--headless", action="store_true", help="服务器模式（无窗口）")
    args = parser.parse_args()

    # 自动查找可用端口
    port = args.port if args.port else find_free_port()

    if args.headless:
        if not args.port:
            logger.error("headless 模式必须指定 --port")
            sys.exit(1)
        start_backend(args.host, port)
    else:
        url = f"http://{args.host}:{port}"

        logger.info(f"Starting backend server on port {port}...")
        backend_thread = threading.Thread(
            target=start_backend,
            args=(args.host, port),
            daemon=True,
        )
        backend_thread.start()

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
        run_desktop_app(args.host, port, args.width, args.height)


if __name__ == "__main__":
    main()
