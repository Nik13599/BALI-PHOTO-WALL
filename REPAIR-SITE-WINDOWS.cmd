@echo off
cd /d "%~dp0"
echo BALI PHOTO WALL - restore baliminsk.online / HTTP 502
echo This operation keeps .env, database, photos and club settings.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-site-windows.ps1"
set "REPAIR_RESULT=%ERRORLEVEL%"
echo.
echo ===== CHECKING LOCAL AND PUBLIC SERVER =====
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\diagnose-windows.ps1"
echo.
if not "%REPAIR_RESULT%"=="0" (
  echo LOCAL REPAIR FAILED. Read the diagnostic messages above.
  echo Run START-WINDOWS.cmd to see the first Node.js startup error.
) else (
  echo Local repair finished. Confirm the public HTTPS check above is OK.
  echo If LOCAL is OK but PUBLIC fails, check duplicate Cloudflare connectors.
)
pause
