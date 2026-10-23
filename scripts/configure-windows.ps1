# Configure BALI PHOTO WALL limits without revealing or changing passwords.
# 0 for GuestPhotoLimit, EventPhotoLimit or RequestsPerHour = no fixed cap.
[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$GuestPhotoLimit = -1,
  [int]$EventPhotoLimit = -1,
  [int]$RequestsPerHour = -1,
  [int]$RetentionDays = -1,
  [int]$MinFreeDiskMB = -1,
  [int]$ConcurrentUploads = -1
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $root '.env' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'No .env configuration. Run INSTALL-WINDOWS.cmd first.' }
$definitions = @(
  @{ Key='MAX_PHOTOS_PER_GUEST'; Parameter='GuestPhotoLimit'; Min=0; Max=1000000; Default=0; Label='Guest uploads unlimited (always 0)' },
  @{ Key='MAX_PHOTOS_PER_EVENT'; Parameter='EventPhotoLimit'; Min=0; Max=100000000; Default=0; Label='Photos per event (0=no cap)' },
  @{ Key='UPLOAD_REQUESTS_PER_HOUR'; Parameter='RequestsPerHour'; Min=0; Max=10000000; Default=0; Label='Upload requests/hour (0=no cap)' },
  @{ Key='RETENTION_DAYS'; Parameter='RetentionDays'; Min=1; Max=90; Default=7; Label='Photo retention days (1-90)' },
  @{ Key='MIN_FREE_DISK_MB'; Parameter='MinFreeDiskMB'; Min=100; Max=100000; Default=512; Label='Reserved disk free space, MB (100-100000)' },
  @{ Key='MAX_ACTIVE_UPLOADS'; Parameter='ConcurrentUploads'; Min=2; Max=32; Default=12; Label='Concurrent uploads (2-32)' }
)
$original = [IO.File]::ReadAllText($ConfigPath,[Text.Encoding]::UTF8)
$lines = [Collections.Generic.List[string]]::new()
foreach ($line in ($original -split '\r?\n')) {
  if ($line -ne '') { $lines.Add($line) }
}
$nonInteractive = @('GuestPhotoLimit','EventPhotoLimit','RequestsPerHour','RetentionDays','MinFreeDiskMB','ConcurrentUploads') |
  Where-Object { $PSBoundParameters.ContainsKey($_) }
Write-Host 'BALI PHOTO WALL / local server settings' -ForegroundColor Green
Write-Host '0 = no fixed limit (only for photos and requests). Hardware safeguards stay enabled.'
foreach ($item in $definitions) {
  $value = [int]$item.Default
  foreach ($line in $lines) {
    if ($line -match ('^'+[Regex]::Escape([string]$item.Key)+'=(\d+)$')) {
      $value = [int]$Matches[1]
    }
  }
  $provided = $PSBoundParameters.ContainsKey($item.Parameter)
  if ($item.Key -eq 'MAX_PHOTOS_PER_GUEST') {
    # Legacy setting may still be 3 on older installations. Disable it permanently.
    $desired = 0
  } elseif ($provided) {
    $desired = [int](Get-Variable -Name $item.Parameter -ValueOnly)
  } elseif ($nonInteractive.Count -eq 0) {
    $inputValue = Read-Host ($item.Label + ' [current '+$value+'] (Enter=keep)')
    if ([string]::IsNullOrWhiteSpace($inputValue)) { continue }
    if ($inputValue -notmatch '^\d+$') { throw ('Expected nonnegative integer: '+$item.Key) }
    $desired = [int]::Parse($inputValue)
  } else { continue }
  if ($desired -lt $item.Min -or $desired -gt $item.Max) {
    throw ('Invalid '+$item.Key+': use '+$item.Min+'..'+$item.Max)
  }
  $found = $false
  for ($i=0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('^'+[Regex]::Escape([string]$item.Key)+'=')) {
      $lines[$i] = [string]$item.Key+'='+$desired
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add([string]$item.Key+'='+$desired) }
  Write-Host ($item.Key + ' = '+$desired)
}
# Update only user-approved settings. Preserve passwords and session secret.
$contents = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
$tempPath = $ConfigPath + '.new'
[IO.File]::WriteAllText($tempPath,$contents,[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempPath -Destination $ConfigPath -Force
Write-Host 'Configuration updated. Restart START-WINDOWS.cmd to apply changes.' -ForegroundColor Green
