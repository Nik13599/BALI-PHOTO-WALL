# Back up SQLite and photo files to data\backups while the server is running.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node=Get-Command node.exe -ErrorAction Stop
Set-Location -LiteralPath $root
Write-Host 'BALI PHOTO WALL / local photo + database backup' -ForegroundColor Green
& $node.Source (Join-Path $PSScriptRoot 'backup.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Backup failed. The backup folder does not contain a complete new backup.' }
Write-Host 'IMPORTANT: Copy backups to an external drive too; backups on the same computer are not hardware protection.'
