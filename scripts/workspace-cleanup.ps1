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
    # Do NOT add mobile-app/android/keys: it holds the mobile release keystore.
    # Deleting it changes the APK signature and every installed device would then
    # reject upgrades with "software conflict".
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

# 根目录临时调试产物（会话遗留的 diff / patch / 构建日志 / 一次性工具）。
# 与 .gitignore 的 `/tmp-*`、`/.tmp-*` 保持同一套定义；改了这里也要同步 .gitignore。
$rootTempGlobs = @('tmp-*', '.tmp-*')

function Clean-RootTempFiles {
  $items = @()
  foreach ($glob in $rootTempGlobs) {
    $items += Get-ChildItem -LiteralPath $Root -Filter $glob -Force -ErrorAction SilentlyContinue
  }
  if ($items.Count -eq 0) {
    Write-Host '  skip (none)'
    return 0
  }
  $freed = 0
  foreach ($item in $items) {
    if ($WhatIf) {
      if ($item.PSIsContainer) {
        $bytes = (Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      } else {
        $bytes = $item.Length
      }
      $mb = [math]::Round(($bytes / 1MB), 1)
      Write-Host "  would remove: $($item.Name) ($mb MB)"
      $freed += $bytes
    } else {
      Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
      Write-Host "  removed: $($item.Name)"
    }
  }
  return $freed
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
      $freed += $bytes
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

Write-Host 'Root temp files (tmp-* / .tmp-*):'
$total += Clean-RootTempFiles

if ($Deep) {
  Write-Host 'Release folder (keeping source-backups):'
  $total += Clean-ReleaseArtifacts
}

if ($WhatIf -and $total -gt 0) {
  $totalMb = [math]::Round(($total / 1MB), 1)
  Write-Host "Would free about $totalMb MB"
}

Write-Host 'Done.'
