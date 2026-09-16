# Workspace cleanup: default = small junk; -Deep = build artifacts (run workspace-backup.ps1 first)
param(
  [switch]$WhatIf,
  [switch]$Deep,
  [switch]$IncludeLocalData
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent

$removePaths = @(
  'vectors.db',
  'vectors.db-shm',
  'vectors.db-wal',
  '.playwright-mcp',
  'logs_llm',
  'build/dieyun-core-linux',
  'deploy/dieyun-online-users-dashboard.zip'
)

if ($Deep) {
  $removePaths += @(
    'node_modules',
    'dist',
    'dist-build',
    'target',
    'build/dieyun-core',
    'build/.cache',
    'build/remote-gateway-pack',
    'src/renderer/dist',
    'src/renderer/index.bundled.html',
    'build-warnings.txt',
    'mobile-app/android/app/build',
    'mobile-app/android/.gradle',
    'mobile-app/android/apk-build',
    'mobile-app/android/manual-build'
  )
}

if ($IncludeLocalData) {
  $removePaths += @(
    '.dieyun/index.sqlite',
    '.dieyun/worktrees',
    '.dieyun/cleanup-backup',
    '.dieyun/attachments'
  )
}

function Remove-TreeIfExists([string]$rel) {
  $full = Join-Path $Root $rel
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Host "  skip (missing): $rel"
    return 0
  }
  if ($WhatIf) {
    if ((Get-Item -LiteralPath $full).PSIsContainer) {
      $bytes = (Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    } else {
      $bytes = (Get-Item -LiteralPath $full).Length
    }
    $mb = [math]::Round(($bytes / 1MB), 1)
    Write-Host "  would remove: $rel ($mb MB)"
    return $bytes
  }
  if ((Get-Item -LiteralPath $full).PSIsContainer) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
  } else {
    Remove-Item -LiteralPath $full -Force -ErrorAction Stop
  }
  Write-Host "  removed: $rel"
  return 0
}

function Clean-ReleaseArtifacts {
  $release = Join-Path $Root 'release'
  if (-not (Test-Path -LiteralPath $release)) {
    Write-Host '  skip (missing): release/'
    return 0
  }
  $keep = Join-Path $release 'source-backups'
  $freed = 0
  Get-ChildItem -LiteralPath $release -Force | ForEach-Object {
    if ($_.FullName -eq $keep) {
      Write-Host '  keep: release/source-backups'
      return
    }
    $rel = 'release/' + $_.Name
    if ($WhatIf) {
      if ($_.PSIsContainer) {
        $bytes = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      } else {
        $bytes = $_.Length
      }
      $mb = [math]::Round(($bytes / 1MB), 1)
      Write-Host "  would remove: $rel ($mb MB)"
      $script:freed += $bytes
    } else {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
      Write-Host "  removed: $rel"
    }
  }
  return $freed
}

Write-Host "Workspace cleanup root: $Root"
if ($Deep) { Write-Host 'Mode: DEEP (build artifacts)' }
if ($IncludeLocalData) { Write-Host 'Mode: include local .dieyun caches' }
if ($WhatIf) { Write-Host 'Mode: WHAT-IF (no deletes)' }

$total = 0
foreach ($rel in $removePaths) {
  $total += Remove-TreeIfExists $rel
}

if ($Deep) {
  Write-Host 'Release folder (keeping source-backups):'
  $total += Clean-ReleaseArtifacts
}

if ($WhatIf -and $total -gt 0) {
  $totalMb = [math]::Round(($total / 1MB), 1)
  Write-Host "Would free about $totalMb MB"
}

Write-Host 'Done.'
