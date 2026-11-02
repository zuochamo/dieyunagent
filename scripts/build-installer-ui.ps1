param([string]$Version = '', [string]$SuggestedVersion = '', [switch]$SkipDeb)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Wait-Exit {
  Write-Host ''
  Write-Host 'Press Enter to close...'
  [void][System.Console]::ReadLine()
}

function Fail([string]$Message) {
  Write-Host ''
  Write-Host '========================================'
  Write-Host ' FAILED'
  Write-Host '========================================'
  Write-Host $Message
  Wait-Exit
  exit 1
}

function Invoke-Step([string]$Label, [scriptblock]$Action) {
  Write-Host ''
  Write-Host $Label
  & $Action
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Fail "Step failed (exit $LASTEXITCODE): $Label" }
}

function Test-Env([string]$Name) {
  $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
  return [string]$v
}

# Ubuntu 包只能在 Linux 构建机上打（deb 里是 Linux ELF core + Linux .node），走 pack:deb:remote。
# 「有没有构建机」的唯一判据与 pack-deb-remote.cjs 读的是同一对来源：
# 环境变量 DIEYUN_LINUX_CORE_SSH 或 dieyun-linux-build.local.json 的 ssh 字段。
function Test-DebHost {
  if (Test-Env 'DIEYUN_LINUX_CORE_SSH') { return $true }
  $cfg = Join-Path $Root 'dieyun-linux-build.local.json'
  if (-not (Test-Path $cfg)) { return $false }
  try {
    $json = Get-Content $cfg -Raw | ConvertFrom-Json
  } catch {
    return $false
  }
  return [bool]("$($json.ssh)".Trim())
}

$debHostReady = Test-DebHost

Clear-Host
Write-Host '========================================'
Write-Host ' Dieyun Agent - Full Build'
Write-Host '========================================'
Write-Host ''
Write-Host ' [1/6] Set PC + mobile version'
Write-Host ' [2/6] PC NSIS (Rust cargo + npm run build:nsis)'
if ($SkipDeb) {
  Write-Host ' [3/6] Ubuntu deb - skipped (-SkipDeb)'
} elseif ($debHostReady) {
  Write-Host ' [3/6] Ubuntu deb (npm run pack:deb:remote on the Linux build host)'
} else {
  Write-Host ' [3/6] Ubuntu deb - skipped (no Linux build host configured)'
}
Write-Host ' [4/6] Android APK (ANDROID_HOME required)'
Write-Host ' [5/6] Publish to Y drive'
Write-Host ' [6/6] Upload to Tencent COS'
Write-Host ''

if ($SuggestedVersion) {
  $currentDev = ''
  try {
    $pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.version) { $currentDev = "$($pkg.version)".Trim() }
  } catch { $currentDev = '' }
  if ($currentDev) { Write-Host " Current dev version (package.json): $currentDev" }
  Write-Host " Suggested release version (PC + mobile): $SuggestedVersion"
  Write-Host ''
}

# The suggestion is only a pre-fill: the operator still confirms before anything is written.
if (-not $Version) {
  $hint = 'Version (e.g. 0.0.47)'
  if ($SuggestedVersion) { $hint = "Version [$SuggestedVersion] (Enter = accept, or type another)" }
  $entered = Read-Host $hint
  $typed = ''
  if ($null -ne $entered) { $typed = $entered.Trim() }
  if ($typed) {
    $Version = $typed
  } elseif ($SuggestedVersion) {
    $Version = $SuggestedVersion
  }
}
$Version = $Version.Trim()
if (-not $Version) { Fail 'Version is empty.' }

if (-not (Test-Env 'ANDROID_HOME')) {
  Fail 'ANDROID_HOME is not set. Install Android Studio SDK (API 34, Build-Tools 34.0.0), set ANDROID_HOME, reopen terminal.'
}

if (-not (Test-Env 'COS_SECRET_ID')) { Fail 'COS_SECRET_ID is not set.' }
if (-not (Test-Env 'COS_SECRET_KEY')) { Fail 'COS_SECRET_KEY is not set.' }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Fail 'cargo not found. Install Rust from https://rustup.rs/ then reopen terminal.'
}

try {
  Invoke-Step "[1/6] Set version: $Version" { node scripts/set-app-version.cjs $Version }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npm) { Fail 'npm not found. Install Node.js.' }

  Invoke-Step '[2/6] Build PC NSIS installer' {
    Write-Host "      cmd: $($npm.Name) run build:nsis"
    & $npm.Source run build:nsis
  }

  $Version = ([string]((Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version)).Trim()
  $distRoot = (& node (Join-Path $Root 'scripts\resolve-build-dist.cjs')).Trim()
  $pcExe = Join-Path $distRoot "dieyunagent-Setup-$Version.exe"
  $pcMap = Join-Path $distRoot "dieyunagent-Setup-$Version.exe.blockmap"
  $latestYml = Join-Path $distRoot 'latest.yml'
  foreach ($f in @($pcExe, $pcMap, $latestYml)) {
    if (-not (Test-Path $f)) {
      $found = @(Get-ChildItem $distRoot -Filter 'dieyunagent-Setup-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
      Fail "Missing: $f`nFound: $(if ($found.Count) { $found -join ', ' } else { '(none)' })"
    }
  }
  Write-Host "      PC installer: $pcExe ($((Get-Item $pcExe).Length) bytes)"

  # 产物名来自 package.json build.deb.artifactName（dieyunagent_${version}_amd64.deb）
  $debPath = Join-Path $distRoot "dieyunagent_${Version}_amd64.deb"
  if ($SkipDeb) {
    Write-Host ''
    Write-Host ' [3/6] Build Ubuntu deb - skipped (-SkipDeb)'
  } elseif (-not $debHostReady) {
    Write-Host ''
    Write-Host ' [3/6] Build Ubuntu deb - skipped (no Linux build host)'
    Write-Host '       Configure dieyun-linux-build.local.json (ssh) or DIEYUN_LINUX_CORE_SSH to enable.'
  } else {
    Invoke-Step '[3/6] Build Ubuntu deb (pack:deb:remote)' {
      Write-Host "      cmd: $($npm.Name) run pack:deb:remote"
      & $npm.Source run pack:deb:remote
    }
    if (-not (Test-Path $debPath)) { Fail "Missing: $debPath" }
    Write-Host "      Ubuntu deb: $debPath ($((Get-Item $debPath).Length) bytes)"
  }

  Invoke-Step '[4/6] Build Android APK' {
    $s = Join-Path $Root 'mobile-app\android\build-manual.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $s
  }

  $mobileApk = Join-Path $Root "dist\mobile\dieyun-mobile-$Version.apk"
  $mobileJson = Join-Path $Root 'dist\mobile\mobile-latest.json'
  foreach ($f in @($mobileApk, $mobileJson)) { if (-not (Test-Path $f)) { Fail "Missing: $f" } }
  Write-Host "      Android APK: $mobileApk ($((Get-Item $mobileApk).Length) bytes)"

  Invoke-Step '[5/6] Publish to Y drive' { cmd /c 'scripts\publish-updates-to-y.bat' }
  Invoke-Step '[6/6] Upload to Tencent COS' { node scripts/upload-updates-cos.mjs }

  Write-Host ''
  Write-Host '========================================'
  Write-Host ' ALL DONE'
  Write-Host '========================================'
  Write-Host " PC: $pcExe"
  if ($debHostReady -and -not $SkipDeb) {
    Write-Host " DEB: $debPath"
  } else {
    Write-Host ' DEB: skipped (not built, not published)'
  }
  Write-Host " APK: $mobileApk"
  Write-Host (' Y: ' + (Join-Path 'Y:' 'client-electron\updates-published'))
  Wait-Exit
  exit 0
} catch {
  Fail ($_.Exception.Message)
}
