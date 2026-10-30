# Bring the local BALI PHOTO WALL server online without changing passwords or photos.
# Cloudflare routes baliminsk.online to 127.0.0.1:3100 on this PC.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$envFile = Join-Path $root '.env'
$nodeModules = Join-Path $root 'node_modules'
$startScript = Join-Path $PSScriptRoot 'start-windows.ps1'
$installScript = Join-Path $PSScriptRoot 'install-windows.ps1'
$autostartScript = Join-Path $PSScriptRoot 'enable-autostart.ps1'
$localUrl = 'http://127.0.0.1:3100/healthz'
$publicUrl = 'https://baliminsk.online/healthz'

function Test-LocalPhotoWall {
  try {
    $r = Invoke-RestMethod -Uri $localUrl -Method Get -TimeoutSec 3 -ErrorAction Stop
    return ($null -ne $r -and $r.ok -eq $true)
  } catch { return $false }
}
function Repair-LocalRouting {
  # Only non-secret routing fields are adjusted. All passwords and data are untouched.
  $original = [IO.File]::ReadAllText($envFile)
  $lines = @($original -split '\r?\n')
  $required = [ordered]@{ HOST='127.0.0.1'; PORT='3100'; PUBLIC_URL='https://baliminsk.online' }
  $found = @{}
  $changed = $false
  $fixed = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match '^\s*(HOST|PORT|PUBLIC_URL)\s*=') {
      $key = $Matches[1].ToUpperInvariant()
      if ($found.ContainsKey($key)) { $changed = $true; continue }
      $found[$key] = $true
      $expected = "$key=$($required[$key])"
      if ($line -cne $expected) { $changed = $true }
      $fixed.Add($expected)
    } else {
      $fixed.Add($line)
    }
  }
  foreach ($key in $required.Keys) {
    if (-not $found.ContainsKey($key)) {
      $fixed.Add("$key=$($required[$key])")
      $changed = $true
    }
  }
  if ($changed) {
    [IO.File]::WriteAllText($envFile,($fixed -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    Write-Host 'Repaired HOST, PORT and PUBLIC_URL in .env. Secret passwords were preserved.' -ForegroundColor Yellow
  }
}
Write-Host 'BALI PHOTO WALL / restore baliminsk.online' -ForegroundColor Cyan
Write-Host 'This tool does not delete photos, databases, or login passwords.'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is missing. Install Node.js 22+ from https://nodejs.org/ and run this again.' }
$nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
if ([version]$nodeVersion -lt [version]'22.0.0') { throw "Node.js 22+ is required. Installed: $nodeVersion" }

if (-not (Test-Path -LiteralPath $envFile) -or -not (Test-Path -LiteralPath $nodeModules)) {
  Write-Warning 'A first-time installation or dependency repair is necessary.'
  & $installScript
  if (-not (Test-Path -LiteralPath $envFile) -or -not (Test-Path -LiteralPath $nodeModules)) {
    throw 'INSTALL-WINDOWS did not prepare .env and node_modules.'
  }
}
$running = Test-LocalPhotoWall
if (-not $running) {
  Repair-LocalRouting
  Write-Host 'Starting the local server in a separate minimized window...'
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
  $arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
  $process = Start-Process -FilePath $psExe -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Minimized -PassThru
  for ($i=0; $i -lt 8; $i++) {
    Start-Sleep -Seconds 2
    if (Test-LocalPhotoWall) { $running = $true; break }
    if ($process.HasExited) { break }
  }
}
if (-not $running) {
  throw 'Local server is not responding at http://127.0.0.1:3100/healthz. Run START-WINDOWS.cmd and read the first error (Node.js, .env or database).'
}
Write-Host 'LOCAL SERVER: OK at http://127.0.0.1:3100' -ForegroundColor Green

try {
  & $autostartScript
  Write-Host 'AUTOSTART: enabled for the current Windows user.' -ForegroundColor Green
} catch {
  Write-Warning ('Could not enable Windows sign-in autostart: ' + $_.Exception.Message)
}

$service = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Write-Warning 'Cloudflared service is missing on THIS computer. A tunnel connector must be installed through Cloudflare Zero Trust.'
} elseif ($service.Status -ne 'Running') {
  Write-Warning 'Cloudflared service is stopped. Start it from Windows Services (services.msc).'
} else {
  Write-Host 'CLOUDFLARE CONNECTOR: Windows service is running.' -ForegroundColor Green
}

try {
  $public = Invoke-RestMethod -Uri $publicUrl -Method Get -TimeoutSec 12 -ErrorAction Stop
  if ($null -ne $public -and $public.ok -eq $true) {
    Write-Host 'PUBLIC SITE: OK at https://baliminsk.online' -ForegroundColor Green
  } else {
    Write-Warning 'Public HTTPS answered, but /healthz was not healthy. Check Cloudflare Tunnel origin routing.'
  }
} catch {
  Write-Warning ('PUBLIC SITE: still not reachable from this PC: ' + $_.Exception.Message)
  Write-Host 'Cloudflare public hostname must point to http://127.0.0.1:3100 on the same PC that runs the connector.'
}
Write-Host 'Guest link: https://baliminsk.online'
Write-Host 'Local moderator: http://127.0.0.1:3100/admin'
Write-Host 'Do not close the minimized Photo Wall server process during events.'
