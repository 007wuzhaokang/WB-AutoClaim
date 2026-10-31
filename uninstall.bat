@echo off
setlocal
echo  Removing AutoClaim startup entries ...
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AutoClaim-AutoStart.vbs" >nul 2>nul
del /q "%USERPROFILE%\Desktop\AutoClaim-Launch.bat" >nul 2>nul
echo  Done. The data folder data\ was NOT deleted.
echo  To fully remove, manually delete D:\WB-AutoClaim\data
pause
