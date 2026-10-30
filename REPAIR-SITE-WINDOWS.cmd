@echo off
cd /d "%~dp0"
echo BALI PHOTO WALL - restore baliminsk.online on this Windows PC
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-site-windows.ps1"
if errorlevel 1 (
  echo.
  echo SITE REPAIR NEEDS ATTENTION. Read the error above.
  echo If necessary, open START-WINDOWS.cmd to see detailed server errors.
) else (
  echo.
  echo Local BALI PHOTO WALL service is ready. See public HTTPS check above.
)
pause
