# Workspace cleanup: default = small junk; -Deep = build artifacts (run workspace-backup.ps1 first)
# -IncludeLocalData 额外回收 .dieyun 本地数据；其中 agent run 的 worktree 一律先走
# `git worktree remove` + `prune`、再删目录，并只回收已并入 HEAD 的 `dieyun/agent-*` 分支。
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
  'deploy/dieyun-online-users-dashboard.zip',
  # 会话遗留的调试 workspace（DB 快照 / 一次性脚本 / 截图）与根目录调试日志，
  # 与 .gitignore 的 `_tmp/`、`debug.log` 同一套定义
  '_tmp',
  'debug.log'
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

# —— agent run 的 worktree / 分支回收 ——
# 为什么不能直接 Remove-Item .dieyun/worktrees：git 在 .git/worktrees/<id> 里存着登记，
# 目录一删，`git worktree list` 与 `git status` 就留下悬挂项；`dieyun/agent-*` 分支也会
# 一直累积（2026-11-21 实测：19 份 worktree 473 MB + 171 条 dieyun/agent-run-* 分支，
# 全是回收只挂在桌面启动路径上、进程被强杀后没人扫的残留）。
# 顺序固定：worktree remove → worktree prune → 删残留目录（下面 removePaths 里那一条）
#           → 只删「已并入 HEAD」的分支。
function Invoke-Git([string[]]$GitArgs) {
  # 只读探针 + 容错分支（`skip (not a git repo)` / `keep worktree (remove failed)`）依赖
  # git 失败**不**终止脚本：Windows PowerShell 5.1 下 `2>&1` 会把原生 stderr 变成
  # ErrorRecord，配合脚本顶部的 `$ErrorActionPreference = 'Stop'` 会抛终止性异常，
  # 于是任何一次 git 报错都会让清理脚本在半途崩掉。这里局部降级，退出码自己判。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $Root @GitArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return @{ ok = ($code -eq 0); out = (@($out) | ForEach-Object { "$_" }) -join "`n" }
}

function Clean-AgentRunWorktrees {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '  skip (git not found)'
    return 0
  }
  if (-not (Invoke-Git @('rev-parse', '--git-dir')).ok) {
    Write-Host '  skip (not a git repo)'
    return 0
  }

  $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
  $rootNorm = $rootFull.Replace('/', '\').ToLowerInvariant()
  $freed = 0

  # 1) 已登记的 worktree 逐份 remove（--force：目录里还有被 gitignore 的残留文件是常态）
  # **只动本仓 agent run 的副本**（`<repo>\.dieyun\worktrees\...`）：`git worktree list` 里还有
  # 开发者自己的 `git worktree add ..\feature-x`，那些不是本脚本的东西，`--force` 删掉就是
  # 未提交改动直接丢失。语义仍以 `src/git/worktree-service.js#sweepRunArtifacts` 为准。
  $agentWtRootNorm = ($rootFull.TrimEnd('\', '/') + '\.dieyun\worktrees\').ToLowerInvariant()
  $listed = Invoke-Git @('worktree', 'list', '--porcelain')
  $wtPaths = @()
  foreach ($line in ($listed.out -split "`n")) {
    $t = $line.Trim()
    if ($t.StartsWith('worktree ')) { $wtPaths += $t.Substring('worktree '.Length) }
  }
  $removedWt = 0
  foreach ($p in $wtPaths) {
    $full = $p.Replace('/', '\')
    $norm = $full.TrimEnd('\', '/').ToLowerInvariant()
    if ($norm -eq $rootNorm) { continue }  # 主工作区
    if (-not $norm.StartsWith($agentWtRootNorm)) {
      Write-Host "  keep worktree (not an agent run copy): $p"
      continue
    }
    $bytes = 0
    if (Test-Path -LiteralPath $full) {
      $bytes = (Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    }
    if ($WhatIf) {
      $mb = [math]::Round(($bytes / 1MB), 1)
      Write-Host "  would remove worktree: $p ($mb MB)"
      $freed += $bytes
      $removedWt += 1
      continue
    }
    $r = Invoke-Git @('worktree', 'remove', '--force', $full)
    if ($r.ok) {
      $freed += $bytes
      $removedWt += 1
      Write-Host "  removed worktree: $p"
    } else {
      Write-Host "  keep worktree (remove failed): $p —— 先人工处置该 run 的产出"
    }
  }
  if ($removedWt -eq 0) { Write-Host '  skip (no agent worktree registered)' }

  # 2) 登记表收尾：删掉的目录在 .git/worktrees 里还留着条目
  if (-not $WhatIf) { [void](Invoke-Git @('worktree', 'prune')) }

  # 3) 分支：只删已并入 HEAD 的；未合并的是还没处置的产出，一律保留并报数
  $brs = Invoke-Git @('for-each-ref', '--format=%(refname:short)', 'refs/heads/dieyun/agent-*')
  $names = @()
  foreach ($line in ($brs.out -split "`n")) {
    $t = $line.Trim()
    if ($t) { $names += $t }
  }
  $deleted = 0
  $kept = 0
  foreach ($name in $names) {
    if (-not (Invoke-Git @('merge-base', '--is-ancestor', $name, 'HEAD')).ok) {
      $kept += 1
      continue
    }
    if ($WhatIf) { Write-Host "  would delete merged branch: $name"; $deleted += 1; continue }
    if ((Invoke-Git @('branch', '-D', $name)).ok) { $deleted += 1 } else { $kept += 1 }
  }
  $verb = 'would delete'; if (-not $WhatIf) { $verb = 'deleted' }
  Write-Host ("  {0} {1} merged agent branches, kept {2} unmerged" -f $verb, $deleted, $kept)
  return $freed
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

# worktree 必须先按 git 的方式解登记，再让下面 removePaths 删 `.dieyun/worktrees` 目录，
# 否则会留下悬挂的 worktree 登记与一堆 agent 分支（见 Clean-AgentRunWorktrees 注释）
if ($IncludeLocalData) {
  Write-Host 'Agent run worktrees / branches:'
  $total += Clean-AgentRunWorktrees
}

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
