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
_backend_started = False  # 防止重复启动后端
_drag_stop_event = None

# Windows API 常量和导入
if IS_WINDOWS:
    import ctypes
    SPI_GETWORKAREA = 0x0030
    VK_LBUTTON = 0x01


def get_work_area():
    """获取屏幕工作区大小（排除任务栏/Dock）"""
    if IS_WINDOWS:
        rect = ctypes.wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
        scale = get_window_scale() if "_window" in globals() else 1.0
        return (
            round(rect.left / scale),
            round(rect.top / scale),
            round((rect.right - rect.left) / scale),
            round((rect.bottom - rect.top) / scale),
        )
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
    def get_cursor_pos() -> tuple[int, int] | None:
        """获取全局鼠标位置（物理像素）。"""
        point = ctypes.wintypes.POINT()
        if ctypes.windll.user32.GetCursorPos(ctypes.byref(point)):
            return point.x, point.y
        return None


    def is_left_mouse_pressed() -> bool:
        """检查鼠标左键是否仍然按下。"""
        return bool(ctypes.windll.user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)


    def get_window_scale() -> float:
        """获取当前窗口 DPI 缩放。"""
        if _window and getattr(_window, "native", None):
            try:
                scale = float(_window.native._scale)
                if scale > 0:
                    return scale
            except Exception:
                pass
        return 1.0


    def stop_window_drag():
        """停止当前 Python 侧拖动/缩放循环。"""
        global _drag_stop_event
        if _drag_stop_event:
            _drag_stop_event.set()
            _drag_stop_event = None


class WindowAPI:
    """暴露给前端的窗口控制 API"""

    def minimize(self):
        """最小化窗口"""
        global _window
        if IS_WINDOWS:
            stop_window_drag()
        if _window:
            _window.minimize()

    def maximize(self):
        """最大化窗口"""
        global _is_maximized, _saved_rect, _window

        if not _window:
            return

        if IS_WINDOWS:
            stop_window_drag()

        # 保存当前窗口位置
        _saved_rect = (_window.x, _window.y, _window.width, _window.height)
        logger.info(f"maximize: saved_rect = {_saved_rect}")

        if IS_WINDOWS:
            work = get_work_area()
            if work:
                _window.resize(work[2], work[3])
                _window.move(work[0], work[1])
            else:
                _window.maximize()
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

        if IS_WINDOWS:
            stop_window_drag()

        if IS_MACOS and _is_fullscreen:
            _window.toggle_fullscreen()
            _is_fullscreen = False
            _is_maximized = False
            return

        if IS_WINDOWS:
            if not _saved_rect:
                return
            _window.resize(_saved_rect[2], _saved_rect[3])
            _window.move(_saved_rect[0], _saved_rect[1])
            _is_maximized = False
            logger.info(f"restore: restored to {_saved_rect}")
            return

        if not _saved_rect:
            return

        _is_maximized = False
        logger.info(f"restore: restored to {_saved_rect}")

    def toggle_maximize(self):
        """切换最大化/还原"""
        if self.is_maximized():
            self.restore()
        else:
            self.maximize()

    def close(self):
        """关闭窗口"""
        global _window
        logger.info("close() called, exiting...")
        if IS_WINDOWS:
            stop_window_drag()
        # 强制退出进程
        import os
        os._exit(0)

    def is_maximized(self):
        """检查窗口是否最大化"""
        global _is_maximized, _is_fullscreen
        return _is_maximized or _is_fullscreen

    def begin_native_drag(self):
        """在 Windows 上启动 Python 侧拖拽循环。"""
        global _drag_stop_event

        if not IS_WINDOWS:
            return False

        if not _window:
            return False

        stop_window_drag()

        start_cursor = get_cursor_pos()
        if not start_cursor:
            return False

        start_window_x = _window.x
        start_window_y = _window.y
        scale = get_window_scale()
        stop_event = threading.Event()
        _drag_stop_event = stop_event

        def drag_loop():
            global _drag_stop_event

            last_position = None
            start_cursor_x, start_cursor_y = start_cursor

            while not stop_event.is_set():
                if not is_left_mouse_pressed():
                    break

                cursor = get_cursor_pos()
                if not cursor:
                    break

                delta_x = round((cursor[0] - start_cursor_x) / scale)
                delta_y = round((cursor[1] - start_cursor_y) / scale)
                new_position = (start_window_x + delta_x, start_window_y + delta_y)

                if new_position != last_position:
                    try:
                        _window.move(new_position[0], new_position[1])
                    except Exception as e:
                        logger.error(f"Python drag move failed: {e}")
                        break
                    last_position = new_position

                time.sleep(0.005)

            if _drag_stop_event is stop_event:
                _drag_stop_event = None

        threading.Thread(target=drag_loop, daemon=True).start()
        return True

    def begin_drag_from_maximized(self, cursor_x: int, cursor_y: int):
        """从最大化状态直接还原并开始拖拽，避免位置闪动。"""
        global _is_maximized

        if not IS_WINDOWS:
            return False

        if not _window or not _saved_rect:
            return False

        stop_window_drag()

        work = get_work_area()
        if not work:
            return False

        restored_width = _saved_rect[2]
        restored_height = _saved_rect[3]
        ratio = min(1, max(0, (cursor_x - work[0]) / max(work[2], 1)))
        min_x = work[0]
        max_x = max(min_x, work[0] + work[2] - restored_width)
        new_x = min(max(round(cursor_x - restored_width * ratio), min_x), max_x)
        new_y = work[1]

        _window.resize(restored_width, restored_height)
        _window.move(new_x, new_y)
        _is_maximized = False

        return self.begin_native_drag()

    def begin_native_resize(self, edge: str):
        """在 Windows 上启动 Python 侧缩放循环。"""
        global _drag_stop_event

        if not IS_WINDOWS:
            return False

        if not _window:
            return False

        stop_window_drag()

        if self.is_maximized():
            return True

        start_cursor = get_cursor_pos()
        if not start_cursor:
            return False

        normalized_edge = edge.lower()
        start_window_x = _window.x
        start_window_y = _window.y
        start_width = _window.width
        start_height = _window.height
        scale = get_window_scale()
        min_width = 800
        min_height = 600
        stop_event = threading.Event()
        _drag_stop_event = stop_event

        def resize_loop():
            global _drag_stop_event

            last_rect = None
            start_cursor_x, start_cursor_y = start_cursor

            while not stop_event.is_set():
                if not is_left_mouse_pressed():
                    break

                cursor = get_cursor_pos()
                if not cursor:
                    break

                delta_x = round((cursor[0] - start_cursor_x) / scale)
                delta_y = round((cursor[1] - start_cursor_y) / scale)

                new_x = start_window_x
                new_y = start_window_y
                new_width = start_width
                new_height = start_height

                if "e" in normalized_edge:
                    new_width = max(min_width, start_width + delta_x)
                if "w" in normalized_edge:
                    new_width = max(min_width, start_width - delta_x)
                    new_x = start_window_x + (start_width - new_width)
                if "s" in normalized_edge:
                    new_height = max(min_height, start_height + delta_y)
                if "n" in normalized_edge:
                    new_height = max(min_height, start_height - delta_y)
                    new_y = start_window_y + (start_height - new_height)

                next_rect = (new_x, new_y, new_width, new_height)
                if next_rect != last_rect:
                    try:
                        _window.resize(new_width, new_height)
                        if new_x != start_window_x or new_y != start_window_y:
                            _window.move(new_x, new_y)
                    except Exception as e:
                        logger.error(f"Python resize failed: {e}")
                        break
                    last_rect = next_rect

                time.sleep(0.005)

            if _drag_stop_event is stop_event:
                _drag_stop_event = None

        threading.Thread(target=resize_loop, daemon=True).start()
        return True

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


def get_loading_html() -> str:
    """返回加载页面 HTML。"""
    return """
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #1e1e1e;
            color: #d4d4d4;
            font-family: 'Segoe UI', system-ui, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            overflow: hidden;
        }
        .logo {
            width: 120px;
            height: 120px;
            margin-bottom: 24px;
            animation: pulse 2s ease-in-out infinite;
        }
        .logo svg {
            width: 100%;
            height: 100%;
        }
        .title {
            font-size: 32px;
            font-weight: 600;
            margin-bottom: 12px;
            color: #ffffff;
            letter-spacing: 2px;
        }
        .status {
            font-size: 14px;
            color: #888;
            margin-bottom: 32px;
        }
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid #333;
            border-top-color: #4af;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(0.98); }
        }
    </style>
</head>
<body>
    <div class="logo">
        <svg viewBox="-45 -40 90 80" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="0" cy="0" rx="38" ry="16" fill="none" stroke="#4af" stroke-width="3"/>
            <path d="M-38,0 Q-10,-28 0,-28 Q10,-28 38,0" fill="none" stroke="#4af" stroke-width="3" stroke-linecap="round"/>
            <circle cx="8" cy="-8" r="7" fill="#4af"/>
            <path d="M-20,-22 Q-14,-32 -6,-30" fill="none" stroke="#4af" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
    </div>
    <div class="title">WinkTerm</div>
    <div class="status">正在启动服务...</div>
    <div class="spinner"></div>
</body>
</html>
"""


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
    webview.start(debug=not IS_FROZEN)


def run_desktop_app_with_loading(host: str, port: int, width: int, height: int):
    """启动桌面应用（先显示加载页面，后端就绪后切换）"""
    import webview

    global _window, _backend_started

    def on_loaded():
        """窗口加载完成后的回调：启动后端并等待就绪"""
        global _backend_started

        # 防止重复启动
        if _backend_started:
            return
        _backend_started = True

        import httpx
        url = f"http://{host}:{port}"

        logger.info(f"Starting backend server on port {port}...")
        backend_thread = threading.Thread(
            target=start_backend,
            args=(host, port),
            daemon=True,
        )
        backend_thread.start()

        logger.info("Waiting for server...")
        for _ in range(100):
            try:
                resp = httpx.get(f"{url}/health", timeout=0.5)
                if resp.status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            logger.error("Backend failed to start")
            return

        logger.info(f"Server ready at {url}")
        # 后端就绪，切换到主页面
        # 使用 evaluate_js 进行页面跳转，保持 js_api 绑定
        _window.evaluate_js(f'window.location.href = "{url}";')

    # 创建窗口，先显示加载页面
    _window = webview.create_window(
        title="WinkTerm",
        html=get_loading_html(),
        width=width,
        height=height,
        resizable=True,
        frameless=True,
        easy_drag=False,
        background_color="#1e1e1e",
        js_api=window_api,
    )

    _window.events.loaded += on_loaded
    webview.start(debug=not IS_FROZEN)


def start_backend(host: str, port: int):
    """启动后端服务"""
    import uvicorn
    from backend.main import app

    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)

    uvicorn.run(app, host=host, port=port, log_level="warning")


def main():
    import argparse

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
        run_desktop_app_with_loading(args.host, port, args.width, args.height)


if __name__ == "__main__":
    main()
