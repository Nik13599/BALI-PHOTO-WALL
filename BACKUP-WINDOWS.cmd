@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\backup-windows.ps1"
if errorlevel 1 echo Backup failed. See the message above.
pause
