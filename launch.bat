@echo off
setlocal
cd /d "%~dp0"

rem Start the service if not running, then open the panel in the browser.
curl -s -o nul -m 2 http://127.0.0.1:8788/ >nul 2>nul
if errorlevel 1 (
  start "" wscript.exe "%~dp0AutoClaim.vbs"
  timeout /t 3 /nobreak >nul
  curl -s -o nul -m 3 http://127.0.0.1:8788/ >nul 2>nul
)

start "" http://127.0.0.1:8788
exit /b 0
