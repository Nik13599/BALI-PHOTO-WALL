# BALI PHOTO WALL update from the official GitHub main branch.
# Preserves .env, data/ and node_modules/. Stop START-WINDOWS.cmd first.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
if(-not (Test-Path -LiteralPath (Join-Path $root '.env'))) { throw 'Missing .env: use INSTALL-WINDOWS.cmd for initial setup.' }
$node=Get-Command node.exe -ErrorAction Stop
$npm=Get-Command npm.cmd -ErrorAction Stop
try {
  $local=Invoke-WebRequest -Uri 'http://127.0.0.1:3100/healthz' -UseBasicParsing -TimeoutSec 2
  if($local.StatusCode -eq 200) { throw 'BALI PHOTO WALL is running. Stop START-WINDOWS.cmd before updating.' }
} catch {
  if($_.Exception.Message -like '*is running*') { throw }
}
Write-Host 'BALI PHOTO WALL / safe Windows update' -ForegroundColor Green
Write-Host 'Preserving secrets, database, uploaded photos and installed dependencies.'
$backupScript=Join-Path $root 'scripts\backup.mjs'
if(Test-Path -LiteralPath $backupScript) {
  & $node.Source $backupScript
  if($LASTEXITCODE -ne 0) { throw 'Pre-update backup failed. Update cancelled to protect the current photos.' }
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('bali-photo-update-'+[Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  $zip=Join-Path $temp 'update.zip'
  Write-Host 'Downloading the latest signed-in project source from GitHub...'
  Invoke-WebRequest -Uri 'https://github.com/Nik13599/BALI-PHOTO-WALL/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 90
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $temp 'unpacked') -Force
  $source=Get-ChildItem -LiteralPath (Join-Path $temp 'unpacked') -Directory | Select-Object -First 1
  if(-not $source -or -not (Test-Path -LiteralPath (Join-Path $source.FullName 'server.mjs'))) {
    throw 'Downloaded archive does not contain the application server.'
  }
  foreach($file in (Get-ChildItem -LiteralPath $source.FullName -File -Recurse)){
    $relative=$file.FullName.Substring($source.FullName.Length+1)
    $first=($relative -split '[\\/]')[0]
    if($first -in @('.env','data','node_modules','.git')) { continue }
    $destination=Join-Path $root $relative
    $directory=Split-Path -Parent $destination
    if(-not (Test-Path -LiteralPath $directory)) {New-Item -ItemType Directory -Path $directory -Force | Out-Null}
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }
  Write-Host 'Updating Node.js packages...'
  & $npm.Source install --no-fund
  if($LASTEXITCODE -ne 0) {throw 'Dependency update failed.'}
  & $npm.Source audit --omit=dev --audit-level=high
  if($LASTEXITCODE -ne 0) {throw 'Security audit failed. Do not expose the server to the internet.'}
  & $npm.Source run check
  if($LASTEXITCODE -ne 0) {throw 'Code check failed.'}
  Write-Host 'Updated! .env, data/ and your passwords were preserved.' -ForegroundColor Green
  Write-Host 'Restart: START-WINDOWS.cmd. Refresh /screen using Ctrl+F5.'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
