@echo off
cd /d "%~dp0"
echo BALI PHOTO WALL - update application code while keeping local data
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-windows.ps1"
if errorlevel 1 echo UPDATE DID NOT FINISH. Read the error above.
pause
