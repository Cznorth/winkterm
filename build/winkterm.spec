# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec 文件 - WinkTerm 桌面应用打包配置

使用方法:
    cd 项目根目录
    pyinstaller build/winkterm.spec --clean --noconfirm
"""
import sys
from pathlib import Path

block_cipher = None

# 项目根目录
ROOT = Path(SPECPATH).parent.resolve()

# site-packages 路径
site_packages = Path(sys.prefix) / "Lib" / "site-packages"

# 判断平台
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# winpty 二进制文件 (Windows)
winpty_dir = site_packages / "winpty"
winpty_binaries = []
if IS_WINDOWS and winpty_dir.exists():
    for f in ["conpty.dll", "winpty.dll", "winpty-agent.exe", "OpenConsole.exe"]:
        fp = winpty_dir / f
        if fp.exists():
            winpty_binaries.append((str(fp), "winpty"))

# 图标路径
if IS_WINDOWS:
    icon_path = str(ROOT / "assets" / "logo.ico")
elif IS_MACOS:
    icon_path = str(ROOT / "assets" / "logo.icns")
else:
    icon_path = None

a = Analysis(
    [str(ROOT / "desktop" / "entrypoint.py")],
    pathex=[str(ROOT)],
    binaries=winpty_binaries,
    datas=[
        # 前端静态文件
        (str(ROOT / "frontend" / "out"), "frontend_static"),
        # 配置示例
        (str(ROOT / ".env.example"), "."),
        # Agent 配置文件
        (str(ROOT / "backend" / "agent" / "registry" / "agents.yaml"), "backend/agent/registry"),
        # Agent 提示词目录
        (str(ROOT / "backend" / "agent" / "prompts"), "backend/agent/prompts"),
    ],
    hiddenimports=[
        # pywebview
        "webview",
        "webview.platforms",
        "webview.platforms.winforms",
        # uvicorn
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        # backend
        "backend",
        "backend.main",
        "backend.config",
        "backend.api.routes",
        "backend.api.ws_routes",
        "backend.api.ws_chat",
        "backend.terminal.pty_manager",
        "backend.terminal.session_manager",
        "backend.terminal.ws_handler",
        "backend.agent",
        "backend.agent.graph",
        "backend.agent.factory",
        "backend.agent.state",
        "backend.agent.core",
        "backend.agent.core.builder",
        "backend.agent.core.state",
        "backend.agent.tools",
        "backend.agent.tools.terminal",
        "backend.agent.tools.monitoring",
        "backend.agent.prompts",
        "backend.agent.registry",
        "backend.agent.registry.loader",
        # ssh
        "backend.ssh",
        "backend.ssh.models",
        "backend.ssh.connection_manager",
        "backend.ssh.file_transfer",
        "backend.ssh.transfer_jobs",
        "backend.ssh.pty_spawner",
        "backend.api.ssh_routes",
        "paramiko",
        "paramiko.ssh_exception",
        "paramiko.transport",
        "paramiko.sftp_client",
        "paramiko.sftp",
        "paramiko.channel",
        "paramiko.client",
        # winpty
        "winpty",
        "winpty.ptyprocess",
        # httpx
        "httpx",
        "httpcore",
        "h11",
        "anyio",
        "anyio._backends",
        "anyio._backends._asyncio",
        # langchain
        "langchain_core",
        "langchain_core.messages",
        "langchain_core.tools",
        "langchain_core.prompts",
        "langchain_core.output_parsers",
        "langchain_core.runnables",
        "langchain_openai",
        "langchain_openai.chat_models",
        "langchain_openai.embeddings",
        "langchain_anthropic",
        "langchain_anthropic.chat_models",
        "langchain_community",
        "langchain_classic",
        "langchain_text_splitters",
        "langgraph",
        "langgraph.checkpoint",
        "langgraph.prebuilt",
        "langgraph.pregel",
        "langgraph.constants",
        # pydantic
        "pydantic",
        "pydantic_settings",
        # websockets
        "websockets",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "PIL",
        "scipy",
        "pandas",
        "pytest",
        "IPython",
        "jupyter",
        "PySide6",
        "shiboken6",
        "cefpython3",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if IS_WINDOWS:
    # Windows: 单文件 .exe
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name="WinkTerm",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_path,
    )
elif IS_MACOS:
    # macOS: .app bundle
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="WinkTerm",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )

    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name="WinkTerm",
    )

    app = BUNDLE(
        coll,
        name="WinkTerm.app",
        icon=icon_path,
        bundle_identifier="com.winkterm.app",
        info_plist={
            "NSPrincipalClass": "NSApplication",
            "NSAppleScriptEnabled": False,
            "CFBundleName": "WinkTerm",
            "CFBundleDisplayName": "WinkTerm",
            "CFBundleVersion": "0.1.0",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleIdentifier": "com.winkterm.app",
            "LSMinimumSystemVersion": "10.13",
            "NSHighResolutionCapable": True,
        },
    )
else:
    # Linux: 单文件
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name="WinkTerm",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
