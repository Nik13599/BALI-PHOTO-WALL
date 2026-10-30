# Start BALI PHOTO WALL on the club computer.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $root '.env'
$server = Join-Path $root 'server.mjs'
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env is missing. Run scripts\install-windows.ps1 first.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) { throw 'Dependencies missing. Run scripts\install-windows.ps1 first.' }
$node = Get-Command node.exe -ErrorAction Stop
Set-Location -LiteralPath $root
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/healthz' -TimeoutSec 3 -ErrorAction Stop
  if ($null -ne $health -and $health.ok -eq $true) {
    Write-Host 'BALI PHOTO WALL is already running at http://127.0.0.1:3100' -ForegroundColor Green
    exit 0
  }
} catch { }
Write-Host 'BALI PHOTO WALL / http://127.0.0.1:3100' -ForegroundColor Green
Write-Host 'Keep this window open. Stop with Ctrl+C.'
while ($true) {
  & $node.Source "--env-file=$envFile" $server
  $exitCode = $LASTEXITCODE
  Write-Warning "Photo Wall exited with code $exitCode. Restarting in 8 seconds."
  Start-Sleep -Seconds 8
}
