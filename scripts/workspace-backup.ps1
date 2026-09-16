# Pack workspace source backup (excludes node_modules and large build outputs)
param(
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) {
  $OutDir = Join-Path $Root 'release/source-backups'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $OutDir "dieyunagent-source-$ts.zip"

Push-Location $Root
try {
  tar -a -cf $dest `
    --exclude=node_modules `
    --exclude=dist `
    --exclude=dist-build `
    --exclude=target `
    --exclude=build/dieyun-core `
    --exclude=build/dieyun-core-linux `
    --exclude=build/.cache `
    --exclude=build/remote-gateway-pack `
    --exclude=models `
    --exclude=mobile-app/android/.gradle `
    --exclude=mobile-app/android/app/build `
    --exclude=release/source-backups `
    --exclude=.git/objects/pack `
    .
} finally {
  Pop-Location
}

$mb = [math]::Round((Get-Item -LiteralPath $dest).Length / 1MB, 2)
Write-Host "Backup: $dest ($mb MB)"
