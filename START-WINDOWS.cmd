@echo off
cd /d "%~dp0"
echo Starting the standalone baliminsk.online photo server...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
echo.
echo BALI PHOTO WALL server has stopped.
pause
