# No passwords, cookies or Cloudflare tokens are shown.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Write-Host 'BALI PHOTO WALL / baliminsk.online readiness check' -ForegroundColor Cyan
$envFile = Join-Path $root '.env'
Write-Host ('Configuration .env: ' + $(if (Test-Path $envFile) { 'PRESENT' } else { 'MISSING' }))
Write-Host ('Node.js dependencies: ' + $(if (Test-Path (Join-Path $root 'node_modules')) { 'PRESENT' } else { 'MISSING' }))
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { Write-Host ('Node.js: ' + (& $node.Source --version)) } else { Write-Warning 'Node.js: MISSING' }
try {
  $local = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/healthz' -UseBasicParsing -TimeoutSec 5
  Write-Host ("Local server: HTTP $($local.StatusCode), $($local.Content)") -ForegroundColor Green
} catch { Write-Warning "Local server: NOT READY ($($_.Exception.Message))" }
try {
  $dns = @(Resolve-DnsName -Name 'baliminsk.online' -Type NS -ErrorAction Stop |
    Where-Object { $_.Type -eq 'NS' } | ForEach-Object { $_.NameHost.TrimEnd('.').ToLowerInvariant() })
  Write-Host ('Domain NS: '+ ($dns -join ', '))
  if ($dns -notcontains 'eric.ns.cloudflare.com' -or $dns -notcontains 'kehlani.ns.cloudflare.com') {
    Write-Warning 'Domain NS are not set to the two Cloudflare nameservers (or DNS has not propagated).'
  }
} catch { Write-Warning 'Could not resolve the domain nameservers.' }
try {
  $public = Invoke-WebRequest -Uri 'https://baliminsk.online/healthz' -UseBasicParsing -TimeoutSec 12
  Write-Host ("Public HTTPS: HTTP $($public.StatusCode), $($public.Content)") -ForegroundColor Green
} catch { Write-Warning "Public HTTPS: NOT READY ($($_.Exception.Message))" }
try {
  $tunnel = Get-Service -Name 'cloudflared' -ErrorAction Stop
  Write-Host ('Cloudflared service: ' + $tunnel.Status)
} catch { Write-Warning 'Cloudflared Windows service is not installed or is named differently.' }
Write-Host 'Guest URL: https://baliminsk.online/'
Write-Host 'Moderator URL on club PC: http://127.0.0.1:3100/admin'
Write-Host 'LED URL on club PC: http://127.0.0.1:3100/screen'
