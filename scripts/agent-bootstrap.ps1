# Restore dieyunagent workspace after cleanup — for AI Agent / local dev.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-bootstrap.ps1
#   powershell -File scripts/agent-bootstrap.ps1 -SkipCore
#   powershell -File scripts/agent-bootstrap.ps1 -BuildCore

param(
    [switch]$SkipCore,
    [switch]$BuildCore,
    [switch]$NoSmoke
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Msg) {
    Write-Host "[dieyun:bootstrap] $Msg"
}

Write-Step 'npm ci...'
npm ci

Write-Step 'bootstrap...'
npm run bootstrap

$coreExe = Join-Path $Root 'target\debug\dieyun-core.exe'
$coreRelease = Join-Path $Root 'target\release\dieyun-core.exe'

if (-not $SkipCore) {
    if (Test-Path $coreExe) {
        Write-Step 'dieyun-core debug binary found'
    } elseif (Test-Path $coreRelease) {
        Write-Step 'dieyun-core release binary found'
    } elseif ($BuildCore) {
        Write-Step 'building dieyun-core (cargo build -p dieyun-core --release)...'
        npm run cargo:build
        Write-Step 'packing dieyun-core sidecar...'
        npm run pack:dieyun-core
    } else {
        Write-Step 'no dieyun-core binary — Node-only smoke will run; Rust tests SKIP'
        Write-Step 'for full tests: re-run with -BuildCore or npm run pack:dieyun-core'
    }
}

if (-not $NoSmoke) {
    Write-Step 'minimal smoke...'
    node scripts/test-agent-smoke.cjs --suite minimal
}

Write-Step 'OK'
Write-Host ''
Write-Host 'Next:'
Write-Host '  npm run dev:fast            # daily Agent dev (skip remote-gateway pack)'
Write-Host '  npm run dev                 # full bootstrap + remote-gateway pack'
Write-Host '  npm test                    # diff-driven smoke'
Write-Host '  npm run test:agent          # agent smoke (skips core tests if no sidecar)'
