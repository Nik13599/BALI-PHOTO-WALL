# BALI PHOTO WALL / read-only 502 gateway diagnostics.
# This script deliberately never prints .env, tokens, passwords, cookies or request headers.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localUrl='http://127.0.0.1:3100'
$publicUrl='https://baliminsk.online'
Write-Host '==== BALI PHOTO WALL / 502 GATEWAY DIAGNOSTICS ====' -ForegroundColor Cyan
Write-Host 'Site: https://baliminsk.online/upload'
Write-Host 'Local origin: http://127.0.0.1:3100'
Write-Host 'Timestamp: ' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
$envPresent=Test-Path -LiteralPath (Join-Path $root '.env')
$depsPresent=Test-Path -LiteralPath (Join-Path $root 'node_modules')
Write-Host ('Environment .env: '+$(if($envPresent){'PRESENT'}else{'MISSING'}))
Write-Host ('Dependencies: '+$(if($depsPresent){'PRESENT'}else{'MISSING'}))
$node=Get-Command node.exe -ErrorAction SilentlyContinue
if($node){Write-Host ('Node.js: '+(& $node.Source --version))}
else{Write-Warning 'Node.js is not installed or is missing from PATH.'}
$nodeCount=@(Get-Process -Name node -ErrorAction SilentlyContinue).Count
Write-Host ('Running node.exe processes: '+$nodeCount)
$cloudflaredCount=@(Get-Process -Name cloudflared -ErrorAction SilentlyContinue).Count
Write-Host ('Running cloudflared.exe processes on THIS PC: '+$cloudflaredCount)
$cloudflaredService=Get-Service -Name cloudflared -ErrorAction SilentlyContinue
if($cloudflaredService){Write-Host ('Cloudflare Windows service: '+$cloudflaredService.Status)}
else{Write-Warning 'Cloudflare service not found (connector may be running manually).'}
$port=Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
if($port){Write-Host 'Port 3100: LISTENING' -ForegroundColor Green}
else{Write-Warning 'Port 3100: NOT LISTENING. Cloudflare Tunnel will return a gateway error.'}
$localReady=$false
try{
 $response=Invoke-RestMethod -Uri "$localUrl/healthz" -TimeoutSec 5 -ErrorAction Stop
 $localReady=($null -ne $response -and $response.ok -eq $true)
 if($localReady){Write-Host 'Local /healthz: OK' -ForegroundColor Green}
 else{Write-Warning 'Local /healthz responded but reported a problem with required files.'}
 if($null -ne $response -and $response.PSObject.Properties.Name -contains 'missingAssets'){
  if(@($response.missingAssets).Count -gt 0){Write-Warning ('Missing app files: '+(@($response.missingAssets) -join ', '))}
 }
}catch{Write-Warning 'Local /healthz: UNAVAILABLE. The PHOTO WALL application is down or unreachable.'}
if($localReady){
 try{
  $response=Invoke-WebRequest -Uri "$localUrl/upload" -Method Head -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
  Write-Host ('Local /upload: HTTP '+$response.StatusCode) -ForegroundColor Green
 }catch{Write-Warning 'Local /upload failed. The application may have an internal server error.'}
}
$publicReady=$false
try{
 $response=Invoke-WebRequest -Uri "$publicUrl/healthz" -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
 $publicReady=($response.StatusCode -eq 200)
 if($publicReady){Write-Host 'Public HTTPS /healthz: OK' -ForegroundColor Green}
 else{Write-Warning ('Public /healthz returned HTTP '+$response.StatusCode)}
}catch{
 $code='UNKNOWN'
 try{
  if($null -ne $_.Exception.Response){$code=[int]$_.Exception.Response.StatusCode}
 }catch{}
 Write-Warning ('Public HTTPS /healthz: FAILED (HTTP '+$code+').')
}
# Distinguish a listening Windows process from the live PHOTO WALL API.
# These checks use public metadata only: no passwords, tokens or photographs.
foreach($address in @(
 @{Label='Local /api/public';Url="$localUrl/api/public"},
 @{Label='Local Telegram controls';Url="$localUrl/api/miniapp/buttons"},
 @{Label='Local contest state';Url="$localUrl/api/contest/status"},
 @{Label='Public Telegram controls';Url="$publicUrl/api/miniapp/buttons"}
)){
 try{
  $started=[Diagnostics.Stopwatch]::StartNew()
  $res=Invoke-WebRequest -Uri $address.Url -UseBasicParsing -TimeoutSec 7 -ErrorAction Stop
  $started.Stop()
  Write-Host ($address.Label+': HTTP '+$res.StatusCode+' ('+[int]$started.ElapsedMilliseconds+' ms)') -ForegroundColor Green
  if($address.Label -eq 'Local Telegram controls'){
   $state=$res.Content | ConvertFrom-Json
   if($state.ok -eq $true){
    Write-Host ('   Button configuration revision: '+$state.revision)
    Write-Host ('   Guest upload event: '+$(if($state.eventAvailable){'ACTIVE'}else{'NOT ACTIVE'}))
   }
  }
 }catch{
  $status='NO RESPONSE'
  try{if($null -ne $_.Exception.Response){$status='HTTP '+[int]$_.Exception.Response.StatusCode}}catch{}
  Write-Warning ($address.Label+': '+$status)
 }
}
# Check intermittent routing to an extra cloudflared replica. We only warn
# here; never stop or delete arbitrary remote tunnel connectors.
$okCount=0
foreach($attempt in 1..3){
 try{
  $r=Invoke-WebRequest -Uri "$publicUrl/api/public" -UseBasicParsing -TimeoutSec 7 -ErrorAction Stop
  if($r.StatusCode -eq 200){$okCount++}
 }catch{}
}
Write-Host ('Public /api/public: '+$okCount+' of 3 attempts succeeded.')
if($okCount -gt 0 -and $okCount -lt 3){
 Write-Warning 'INTERMITTENT origin: verify that every cloudflared connector for bali-photo-wall runs on the Windows machine with Node.js port 3100.'
}
Write-Host ''
if(-not $envPresent -or -not $depsPresent -or -not $localReady){
 Write-Host 'NEXT STEP: run REPAIR-SITE-WINDOWS.cmd on THIS PC.' -ForegroundColor Yellow
 Write-Host 'If that fails, open START-WINDOWS.cmd and capture its FIRST startup error.'
}elseif(-not $publicReady){
 Write-Host 'Local server is healthy, but public HTTPS fails.' -ForegroundColor Yellow
 Write-Host 'Cloudflare has TWO live Windows connectors for this tunnel. Check that each runs' -ForegroundColor Yellow
 Write-Host 'on the SAME PC as Node.js, or remove the stale duplicate connector in Zero Trust.' -ForegroundColor Yellow
 Write-Host 'Do NOT remove DNS records or replace the already configured tunnel.'
}else{
 Write-Host 'LOCAL AND PUBLIC HEALTH CHECKS PASSED.' -ForegroundColor Green
 Write-Host 'If only mobile QR still fails, retry https://baliminsk.online/upload'
}
Write-Host ''
Write-Host 'Moderator: https://baliminsk.online/admin/general'
Write-Host 'Guest photo upload: https://baliminsk.online/upload'
Write-Host '============================================'
