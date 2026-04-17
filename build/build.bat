@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   WinkTerm Desktop Builder
echo ========================================

cd /d "%~dp0\.."

:: 检查虚拟环境
if not exist ".venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found
    echo Please run: python -m venv .venv
    exit /b 1
)

:: 激活虚拟环境
call .venv\Scripts\activate.bat

:: 1. 构建前端
echo.
echo [1/3] Building frontend...
cd frontend
if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install
)
call npm run build
if errorlevel 1 (
    echo ERROR: Frontend build failed
    exit /b 1
)
cd ..

:: 检查前端构建结果
if not exist "frontend\out\index.html" (
    echo ERROR: Frontend build failed - no index.html found
    exit /b 1
)

:: 2. 安装打包依赖
echo.
echo [2/3] Installing packaging dependencies...
pip install pyinstaller pywebview httpx --quiet

:: 3. PyInstaller 打包
echo.
echo [3/3] Building executable...
pyinstaller build\winkterm.spec --clean --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    exit /b 1
)

:: 检查结果
if exist "dist\WinkTerm.exe" (
    echo.
    echo ========================================
    echo   Build successful!
    echo   Output: dist\WinkTerm.exe
    echo ========================================
    echo.
    echo Usage:
    echo   - Desktop mode:  dist\WinkTerm.exe
    echo   - Server mode:   dist\WinkTerm.exe --headless --host 0.0.0.0 --port 8000
) else (
    echo ERROR: Build failed - executable not found
    exit /b 1
)
