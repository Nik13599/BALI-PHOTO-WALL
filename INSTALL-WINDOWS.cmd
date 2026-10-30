@echo off
cd /d "%~dp0"
echo BALI PHOTO WALL - Windows installer for baliminsk.online
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation was NOT completed. Read the error above.
  pause
  exit /b 1
)
echo.
echo Installation complete. Starting PHOTO WALL and enabling Windows sign-in autostart...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-site-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation succeeded, but the website was not fully restored.
  echo Run REPAIR-SITE-WINDOWS.cmd or START-WINDOWS.cmd and read the error.
  pause
  exit /b 1
)
echo.
echo BALI PHOTO WALL locally started. Check HTTPS status above.
pause
