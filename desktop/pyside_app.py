"""PySide6 桌面应用 - 无边框窗口"""
from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# 判断运行环境
IS_FROZEN = getattr(sys, "frozen", False)


def run_desktop_app(host: str, port: int, width: int, height: int):
    """启动桌面应用"""
    from PySide6.QtCore import QUrl, Qt, QPoint, QSize
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import (
        QApplication,
        QMainWindow,
        QVBoxLayout,
        QWidget,
        QHBoxLayout,
        QPushButton,
        QLabel,
        QSizeGrip,
    )
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEnginePage

    url = f"http://{host}:{port}"

    class TitleBar(QWidget):
        """自定义标题栏"""

        def __init__(self, parent: QMainWindow):
            super().__init__(parent)
            self.main_window = parent
            self.press_pos = QPoint()
            self.setFixedHeight(32)
            self.setup_ui()

        def setup_ui(self):
            layout = QHBoxLayout(self)
            layout.setContentsMargins(8, 0, 0, 0)
            layout.setSpacing(8)

            # Logo
            logo = QLabel("W")
            logo.setFixedSize(20, 20)
            logo.setStyleSheet("""
                QLabel {
                    background: #0078d4;
                    color: white;
                    font-weight: bold;
                    font-size: 12px;
                    border-radius: 4px;
                    qproperty-alignment: AlignCenter;
                }
            """)
            layout.addWidget(logo)

            # 标题
            title = QLabel("WinkTerm")
            title.setStyleSheet("color: #969696; font-size: 12px;")
            layout.addWidget(title)

            layout.addStretch()

            # 窗口控制按钮
            btn_style = """
                QPushButton {
                    background: transparent;
                    border: none;
                    color: #969696;
                    font-size: 12px;
                    min-width: 46px;
                    min-height: 32px;
                }
                QPushButton:hover {
                    background: #2a2d2e;
                    color: #cccccc;
                }
            """

            self.btn_min = QPushButton("─")
            self.btn_min.setStyleSheet(btn_style)
            self.btn_min.clicked.connect(self.main_window.showMinimized)
            layout.addWidget(self.btn_min)

            self.btn_max = QPushButton("□")
            self.btn_max.setStyleSheet(btn_style)
            self.btn_max.clicked.connect(self.toggle_maximize)
            layout.addWidget(self.btn_max)

            self.btn_close = QPushButton("✕")
            self.btn_close.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    border: none;
                    color: #969696;
                    font-size: 12px;
                    min-width: 46px;
                    min-height: 32px;
                }
                QPushButton:hover {
                    background: #e81123;
                    color: white;
                }
            """)
            self.btn_close.clicked.connect(self.main_window.close)
            layout.addWidget(self.btn_close)

        def toggle_maximize(self):
            if self.main_window.isMaximized():
                self.main_window.showNormal()
                self.btn_max.setText("□")
            else:
                self.main_window.showMaximized()
                self.btn_max.setText("❐")

        def mousePressEvent(self, event):
            if event.button() == Qt.LeftButton:
                self.press_pos = event.globalPosition().toPoint() - self.main_window.frameGeometry().topLeft()

        def mouseMoveEvent(self, event):
            if not self.press_pos.isNull():
                self.main_window.move(event.globalPosition().toPoint() - self.press_pos)

        def mouseDoubleClickEvent(self, event):
            self.toggle_maximize()

    class MainWindow(QMainWindow):
        """主窗口"""

        def __init__(self):
            super().__init__()
            self.setWindowFlags(Qt.FramelessWindowHint)
            self.setAttribute(Qt.WA_TranslucentBackground, False)
            self.setStyleSheet("background-color: #1e1e1e;")
            self.resize(width, height)

            # 中央部件
            central = QWidget()
            self.setCentralWidget(central)
            layout = QVBoxLayout(central)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(0)

            # 标题栏
            self.title_bar = TitleBar(self)
            layout.addWidget(self.title_bar)

            # WebView
            self.webview = QWebEngineView()
            self.webview.setUrl(QUrl(url))
            self.webview.setStyleSheet("background-color: #1e1e1e;")
            layout.addWidget(self.webview)

            # 右下角调整大小手柄
            self.size_grip = QSizeGrip(self)
            self.size_grip.setFixedSize(16, 16)
            self.size_grip.setStyleSheet("background: transparent;")

        def resizeEvent(self, event):
            super().resizeEvent(event)
            # 将 size grip 放在右下角
            self.size_grip.move(self.width() - 16, self.height() - 16)

        def toggle_maximize(self):
            self.title_bar.toggle_maximize()

    # 创建应用
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    window = MainWindow()
    window.show()

    logger.info(f"Desktop app started: {url}")
    sys.exit(app.exec())


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
        import httpx
        import time

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
