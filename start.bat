@echo off
setlocal
cd /d "%~dp0"

rem If an instance is already running, just open the panel (avoid double listener).
curl -s -o nul -m 2 http://127.0.0.1:8788/ >nul 2>nul
if not errorlevel 1 (
  if /i not "%~1"=="/silent" start "" http://127.0.0.1:8788
  exit /b 0
)

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE_EXE="
  for %%P in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%APPDATA%\nvm\current\node.exe"
  ) do (
    if not defined NODE_EXE if exist %%P set "NODE_EXE=%%~P"
  )
)

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js not found. Please install Node.js 18+.
  echo.
  pause
  exit /b 1
)

echo.
echo  AutoClaim starting ...
echo  Panel:  http://127.0.0.1:8788
echo  Data:   %~dp0data
echo.

if /i not "%~1"=="/silent" (
  start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8788"
)

:loop
"%NODE_EXE%" server.js
echo.
echo [%date% %time%] server exited, restarting in 5s ...
timeout /t 5 /nobreak >nul
goto loop
