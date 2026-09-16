# One-time: ensure build key + install public key on remote server
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
node (Join-Path $root 'scripts\ensure-dieyun-linux-ssh-key.cjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$pubPath = Join-Path $env:USERPROFILE '.ssh\id_ed25519_dieyunagent.pub'
$keyPath = Join-Path $env:USERPROFILE '.ssh\id_ed25519_dieyunagent'
$hostLine = 'dieyunx@192.168.31.62'

$pub = (Get-Content $pubPath -Raw).Trim()
$pubEsc = $pub.Replace("'", "'\''")

Write-Host "Installing public key on $hostLine ..."
Write-Host "Enter dieyunx SERVER login password."
Write-Host ""

$remoteCmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$pubEsc' ~/.ssh/authorized_keys || echo '$pubEsc' >> ~/.ssh/authorized_keys"

& ssh '-oPreferredAuthentications=password' '-oPubkeyAuthentication=no' $hostLine $remoteCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Verifying key login..."
& ssh '-i' $keyPath '-oIdentitiesOnly=yes' '-oBatchMode=yes' $hostLine 'echo ok; whoami; hostname'
if ($LASTEXITCODE -ne 0) {
  Write-Error "Verification failed."
}

Write-Host ""
Write-Host "Done. Run: npm run pack:dieyun-core:linux:remote"
