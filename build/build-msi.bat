@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   WinkTerm MSI Builder
echo ========================================

cd /d "%~dp0\.."

:: Resolve WinkTerm version from source so the MSI stays in sync.
for /f "tokens=2 delims==" %%V in ('findstr /r /c:"^APP_VERSION" backend\api\routes.py') do (
    set "RAW_VER=%%V"
)
:: Strip surrounding quotes/whitespace
set "APP_VERSION=%RAW_VER:"=%"
set "APP_VERSION=%APP_VERSION: =%"
if "%APP_VERSION%"=="" (
    echo WARNING: could not parse APP_VERSION, falling back to 0.0.0
    set "APP_VERSION=0.0.0"
)
echo Version: %APP_VERSION%

:: ---- Step 1: Build the single-file WinkTerm.exe via build.bat ----
echo.
echo [1/3] Building WinkTerm.exe...
call build\build.bat
if errorlevel 1 (
    echo ERROR: WinkTerm.exe build failed, aborting MSI packaging.
    exit /b 1
)
if not exist "dist\WinkTerm.exe" (
    echo ERROR: dist\WinkTerm.exe not found after build.
    exit /b 1
)

:: ---- Step 2: Locate the WiX v4/v5 CLI ----
echo.
echo [2/3] Locating WiX...
where wix >nul 2>nul
if %errorlevel%==0 (
    set "WIX_CMD=wix"
) else (
    :: Fall back to the dotnet global tools path (%USERPROFILE%\.dotnet\tools)
    if exist "%USERPROFILE%\.dotnet\tools\wix.exe" (
        set "WIX_CMD=%USERPROFILE%\.dotnet\tools\wix.exe"
    ) else (
        echo ERROR: WiX CLI not found.
        echo Install it with:  dotnet tool install -g wix
        exit /b 1
    )
)
echo Using: %WIX_CMD%

:: ---- Step 3: Build the MSI ----
echo.
echo [3/3] Building MSI...
set "MSI_OUT=dist\WinkTerm-%APP_VERSION%-x64.msi"
:: Inject the parsed version into the .wxs via a preprocessor variable so the
:: MSI's internal ProductVersion stays in sync with the filename automatically.
%WIX_CMD% build build\winkterm.wxs -o "%MSI_OUT%" -arch x64 -d AppVersion=%APP_VERSION%
if errorlevel 1 (
    echo ERROR: WiX build failed.
    exit /b 1
)

if exist "%MSI_OUT%" (
    echo.
    echo ========================================
    echo   MSI build successful!
    echo   Output: %MSI_OUT%
    echo ========================================
    echo.
    echo Install silently:
    echo   msiexec /i "%MSI_OUT%" /quiet
    echo Uninstall silently:
    echo   msiexec /x "%MSI_OUT%" /quiet
) else (
    echo ERROR: MSI not found after build.
    exit /b 1
)
