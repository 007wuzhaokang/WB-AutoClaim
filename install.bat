@echo off
setlocal
cd /d "%~dp0"
echo.
echo  -- AutoClaim deploy --
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
copy /y "%~dp0AutoClaim.vbs" "%STARTUP%\AutoClaim-AutoStart.vbs" >nul
if exist "%STARTUP%\AutoClaim-AutoStart.vbs" (echo  [1/3] Startup shortcut: OK) else (echo  [1/3] Startup shortcut: FAILED)

copy /y "%~dp0launch.bat" "%USERPROFILE%\Desktop\AutoClaim-Launch.bat" >nul
if exist "%USERPROFILE%\Desktop\AutoClaim-Launch.bat" (echo  [2/3] Desktop entry: OK) else (echo  [2/3] Desktop entry: FAILED)

echo  [3/3] Starting now ...
call "%~dp0launch.bat"
echo.
echo  Deploy done. Data in %~dp0data
pause
