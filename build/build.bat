@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   WinkTerm Desktop Builder
echo ========================================

cd /d "%~dp0\.."

:: Check virtual environment
if not exist ".venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found
    echo Please run: python -m venv .venv
    exit /b 1
)

:: Activate virtual environment
call .venv\Scripts\activate.bat

:: 1. Build frontend
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

:: Check frontend build output
if not exist "frontend\out\index.html" (
    echo ERROR: Frontend build failed - no index.html found
    exit /b 1
)

:: 2. Install packaging dependencies
echo.
echo [2/3] Installing packaging dependencies...
where uv >nul 2>nul
if %errorlevel%==0 (
    echo Using uv pip...
    call uv pip install --python .venv\Scripts\python.exe pyinstaller pywebview httpx
) else (
    echo uv not found, falling back to python -m pip...
    call .venv\Scripts\python.exe -m pip install pyinstaller pywebview httpx --quiet
)
if errorlevel 1 (
    echo ERROR: Packaging dependency install failed
    exit /b 1
)

:: 3. Build with PyInstaller
echo.
echo [3/3] Building executable...
call .venv\Scripts\python.exe -m PyInstaller build\winkterm.spec --clean --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    exit /b 1
)

:: Check result
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
