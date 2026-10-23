# One-time BALI PHOTO WALL setup for Windows.
# powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
[CmdletBinding()]
param([switch]$SkipAudit)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root

function Read-PhotoWallPassword([string]$label) {
  while ($true) {
    $secure = Read-Host "$label (12+ chars, hidden input)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($plain.Length -lt 12) { Write-Warning 'At least 12 characters are required.'; continue }
    if ($plain -match '[\r\n"#]') {
      Write-Warning 'Password cannot contain quotation marks, # or newlines because it is written to .env.'
      continue
    }
    return $plain
  }
}
Write-Host 'BALI PHOTO WALL / Windows installation' -ForegroundColor Green
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'Install Node.js 22 LTS or later from https://nodejs.org/, restart PowerShell and repeat.'
}
$versionText = (& $node.Source -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or [version]$versionText -lt [version]'22.0.0') {
  throw "Node.js 22+ is required. Found: $versionText"
}
Write-Host "Node.js: $versionText"
$envFile = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Host 'Creating .env with unique local passwords.' -ForegroundColor Cyan
  $admin = Read-PhotoWallPassword 'Administrator password'
  $screen = Read-PhotoWallPassword 'LED screen operator password'
  if ($admin -ceq $screen) { throw 'Admin and LED screen passwords must be different. Repeat installation.' }
  $bytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $secret = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')
  $lines = @(
    'NODE_ENV=production',
    'HOST=127.0.0.1',
    'PORT=3100',
    'PUBLIC_URL=https://baliminsk.online',
    "ADMIN_PASSWORD=$admin",
    "SCREEN_PASSWORD=$screen",
    "SESSION_SECRET=$secret",
    'RETENTION_DAYS=7',
    'MAX_PHOTOS_PER_GUEST=0',
    'MAX_PHOTOS_PER_EVENT=0',
    'UPLOAD_REQUESTS_PER_HOUR=0',
    'MIN_FREE_DISK_MB=512',
    'MAX_ACTIVE_UPLOADS=12'
  )
  [IO.File]::WriteAllText($envFile,($lines -join [Environment]::NewLine) + [Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  Write-Host '.env created. Never upload this file to GitHub.' -ForegroundColor Green
  $admin = $null; $screen = $null
} else {
  Write-Host 'Existing .env preserved (passwords are not overwritten).' -ForegroundColor Yellow
}
Write-Host 'Installing Node.js dependencies...'
& $npm.Source install --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check internet connection or missing Windows native build dependencies.' }
if (-not $SkipAudit) {
  Write-Host 'Checking installed production dependencies...'
  & $npm.Source audit --omit=dev --audit-level=high
  if ($LASTEXITCODE -ne 0) { throw 'npm audit reported problems. Do not put Photo Wall online until resolved.' }
}
Write-Host 'Checking JavaScript syntax...'
& $npm.Source run check
if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed.' }
Write-Host 'Installation complete.' -ForegroundColor Green
Write-Host 'Start locally: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1'
Write-Host 'Verify status: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-windows.ps1'
Write-Host 'Auto-start on sign-in: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-autostart.ps1'
Write-Host 'Edit limits: double-click CONFIGURE-WINDOWS.cmd (0 = no fixed photo/request quota).'
Write-Host 'Cloudflare Tunnel connector must be installed separately using the existing Cloudflare dashboard.'
