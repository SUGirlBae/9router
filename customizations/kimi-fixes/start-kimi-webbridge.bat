@echo off
chcp 651 >nul
title Kimi WebBridge Startup Script

echo ================================================
echo   Kimi WebBridge for 9router - Cloudflare Bypass
echo ================================================
echo.

REM Check if WebBridge exists
if not exist "%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe" (
    echo ERROR: kimi-webbridge.exe not found!
    echo Please install Kimi WebBridge first.
    pause
    exit /b 1
)

REM Set default port
set WEBBRIDGE_PORT=3000

REM Check if port is available
netstat -ano | findstr ":%WEBBRIDGE_PORT%" | findstr "LISTENING" >nul
if %errorlevel% == 0 (
    echo WARNING: Port %WEBBRIDGE_PORT% is already in use!
    echo Trying alternative port...
    set WEBBRIDGE_PORT=3001
)

echo Starting Kimi WebBridge on port %WEBBRIDGE_PORT%...
echo.
echo IMPORTANT: Keep this window open while using 9router!
echo.
echo After starting, configure 9router with:
echo   Proxy Endpoint: http://localhost:%WEBBRIDGE_PORT%
echo.
echo Press Ctrl+C to stop WebBridge
echo.

cd /d "%USERPROFILE%\.kimi-webbridge\bin"
.\kimi-webbridge.exe --port %WEBBRIDGE_PORT% --headless false

pause