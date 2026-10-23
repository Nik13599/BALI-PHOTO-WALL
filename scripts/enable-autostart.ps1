# Start BALI PHOTO WALL after this Windows user signs in.
# No administrator rights required. Tunnel autostart is configured separately.
[CmdletBinding()]
param([switch]$Disable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startup = [Environment]::GetFolderPath('Startup')
if ([string]::IsNullOrWhiteSpace($startup)) { throw 'Cannot find Windows Startup folder.' }
$linkPath = Join-Path $startup 'BALI PHOTO WALL.lnk'
if ($Disable) {
  Remove-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
  Write-Host 'BALI PHOTO WALL autostart disabled.'
  exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
  throw 'Run scripts\install-windows.ps1 before enabling autostart.'
}
$startScript = Join-Path $PSScriptRoot 'start-windows.ps1'
$powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe)) { throw 'Windows PowerShell executable not found.' }
$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($linkPath)
$link.TargetPath = $powershellExe
$link.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$startScript`""
$link.WorkingDirectory = $root
$link.Description = 'Start the independent BALI PHOTO WALL app for baliminsk.online'
$link.WindowStyle = 7
$link.Save()
Write-Host "Windows autostart created: $linkPath" -ForegroundColor Green
Write-Host 'It runs after sign-in. Keep the PC powered on and disable sleep during club hours.'
