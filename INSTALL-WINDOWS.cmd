@echo off
cd /d "%~dp0"
echo BALI PHOTO WALL - Windows installer for baliminsk.online
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation was NOT completed. Read the error above.
) else (
  echo.
  echo Installation steps completed.
)
pause
