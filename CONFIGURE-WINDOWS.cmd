@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-windows.ps1"
if errorlevel 1 echo Settings were not applied. Check the message above.
pause
