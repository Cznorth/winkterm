"""WebView 桌面应用 - 无边框窗口 + 自定义标题栏"""
from __future__ import annotations

import ctypes
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

# Windows API 常量
SM_CXSCREEN = 0
SM_CYSCREEN = 1
SPI_GETWORKAREA = 0x0030
SWP_NOZORDER = 0x0004
SWP_SHOWWINDOW = 0x0040

# 全局状态
_window = None
_is_maximized = False
_saved_rect = None
_hwnd = None


def get_work_area():
    """获取屏幕工作区大小（排除任务栏）"""
    rect = ctypes.wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def find_window_handle():
    """查找窗口句柄"""
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
        """最大化窗口（不覆盖任务栏）- 使用 Windows API"""
        global _is_maximized, _saved_rect, _hwnd, _window

        if not _window:
            return

        hwnd = find_window_handle()
        if not hwnd:
            logger.error("maximize: hwnd not found")
            # 降级到 pywebview 方式
            _saved_rect = (_window.x, _window.y, _window.width, _window.height)
            work_x, work_y, work_w, work_h = get_work_area()
            _window.resize(work_w, work_h)
            _window.move(work_x, work_y)
            _is_maximized = True
            return

        # 保存当前窗口位置
        _saved_rect = (_window.x, _window.y, _window.width, _window.height)
        logger.info(f"maximize: saved_rect = {_saved_rect}")

        # 获取工作区大小
        work_x, work_y, work_w, work_h = get_work_area()
        logger.info(f"maximize: work_area = ({work_x}, {work_y}, {work_w}, {work_h})")

        # 使用 Windows API 设置窗口位置和大小
        user32 = ctypes.windll.user32
        user32.SetWindowPos(hwnd, 0, work_x, work_y, work_w, work_h, SWP_NOZORDER | SWP_SHOWWINDOW)

        _is_maximized = True
        logger.info(f"maximize: done via Windows API")

    def restore(self):
        """还原窗口"""
        global _is_maximized, _saved_rect, _hwnd, _window

        if not _window or not _saved_rect:
            return

        hwnd = find_window_handle()

        if hwnd:
            # 使用 Windows API
            user32 = ctypes.windll.user32
            user32.SetWindowPos(hwnd, 0, _saved_rect[0], _saved_rect[1],
                               _saved_rect[2], _saved_rect[3], SWP_NOZORDER | SWP_SHOWWINDOW)
        else:
            # 降级到 pywebview
            _window.resize(_saved_rect[2], _saved_rect[3])
            _window.move(_saved_rect[0], _saved_rect[1])

        _is_maximized = False
        logger.info(f"restore: restored to {_saved_rect}")

    def toggle_maximize(self):
        """切换最大化/还原"""
        global _is_maximized
        if _is_maximized:
            self.restore()
        else:
            self.maximize()

    def close(self):
        """关闭窗口"""
        global _window
        if _window:
            _window.destroy()

    def is_maximized(self):
        """检查窗口是否最大化"""
        return _is_maximized

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
        work_x, work_y, work_w, work_h = get_work_area()
        return {"x": work_x, "y": work_y, "width": work_w, "height": work_h}


# 创建 API 实例
window_api = WindowAPI()


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
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--width", type=int, default=1400)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--headless", action="store_true", help="服务器模式（无窗口）")
    args = parser.parse_args()

    if args.headless:
        start_backend(args.host, args.port)
    else:
        url = f"http://{args.host}:{args.port}"

        logger.info("Starting backend server...")
        backend_thread = threading.Thread(
            target=start_backend,
            args=(args.host, args.port),
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
        run_desktop_app(args.host, args.port, args.width, args.height)


if __name__ == "__main__":
    main()
