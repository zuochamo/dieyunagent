# proc-spike-watch.ps1 - read-only process spike monitor
#
# Purpose: when CPU/RAM suddenly spikes, capture WHO it is (process, parent chain,
#          full command line) into a CSV so it can be diagnosed afterwards.
# Cost:    one Get-Process per round; CIM query only when a threshold is hit.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diag/proc-spike-watch.ps1
#   powershell ... -File scripts/diag/proc-spike-watch.ps1 -Minutes 30 -CpuThreshold 30
#   powershell ... -File scripts/diag/proc-spike-watch.ps1 -Minutes 1
#
# Output:
#   %APPDATA%\dieyunagent\diag\proc-spikes-YYYYMMDD.csv   (structured)
#   %APPDATA%\dieyunagent\diag\proc-spikes-YYYYMMDD.log   (same, plain text)

param(
  [int]$IntervalSec = 2,
  [double]$CpuThreshold = 40,
  [double]$SysThreshold = 85,
  [double]$Minutes = 0,
  [switch]$Once,
  [string]$OutDir = (Join-Path $env:APPDATA 'dieyunagent\diag')
)

$ErrorActionPreference = 'Stop'
if ($Once -and $Minutes -le 0) { $Minutes = 1 }

$null = New-Item -ItemType Directory -Force -Path $OutDir
$stamp = Get-Date -Format 'yyyyMMdd'
$csvPath = Join-Path $OutDir "proc-spikes-$stamp.csv"
$logPath = Join-Path $OutDir "proc-spikes-$stamp.log"

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$deadline = $null
if ($Minutes -gt 0) { $deadline = (Get-Date).AddMinutes($Minutes) }
$lastHit = @{}
$hits = 0
$rounds = 0

function Get-ParentChain([int]$procId, [hashtable]$byId, [int]$maxDepth) {
  $chain = @()
  $cur = $byId[$procId]
  $depth = 0
  while ($cur -and $depth -lt $maxDepth) {
    $chain += ("{0}({1})" -f $cur.Name, $cur.ProcessId)
    $cur = $byId[[int]$cur.ParentProcessId]
    $depth++
  }
  return ($chain -join ' <- ')
}

function Write-Hit([string]$name, [int]$procId, [double]$cpuPct, [double]$wsMb) {
  $all = Get-CimInstance Win32_Process
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $target = $byId[$procId]
  $line = '<gone>'
  if ($target -and $target.CommandLine) { $line = $target.CommandLine -replace '\s+', ' ' }
  $chain = Get-ParentChain $procId $byId 6
  $obj = [pscustomobject]@{
    Time    = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    PID     = $procId
    Name    = $name
    CPU_pct = [math]::Round($cpuPct, 1)
    WS_MB   = [math]::Round($wsMb, 0)
    Chain   = $chain
    CmdLine = $line
  }
  if (Test-Path $csvPath) {
    $obj | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8 -Append
  } else {
    $obj | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
  }
  $msg = "[{0}] {1} pid={2} cpu={3}% ws={4}MB`r`n    chain: {5}`r`n    cmd:   {6}" -f $obj.Time, $name, $procId, $obj.CPU_pct, $obj.WS_MB, $chain, $line
  Write-Host $msg -ForegroundColor Yellow
  Add-Content -Path $logPath -Value $msg -Encoding UTF8
  $script:hits = $script:hits + 1
}

Write-Host ("monitor start: interval={0}s  threshold: proc {1}% / system {2}%  cores={3}" -f $IntervalSec, $CpuThreshold, $SysThreshold, $cores) -ForegroundColor Cyan
Write-Host ("csv: " + $csvPath) -ForegroundColor DarkGray
if ($deadline) { Write-Host ("until " + $deadline.ToString('HH:mm:ss')) -ForegroundColor DarkGray }

$prev = @{}
foreach ($p in (Get-Process)) {
  try { $prev[$p.Id] = $p.TotalProcessorTime.TotalSeconds } catch { }
}
$prevAt = Get-Date

while ($true) {
  if ($deadline -and (Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds $IntervalSec
  $nowAt = Get-Date
  $elapsed = [math]::Max(($nowAt - $prevAt).TotalSeconds, 0.001)
  $rounds++
  $totalDelta = 0
  $snapshot = Get-Process
  $cur = @{}
  foreach ($p in $snapshot) {
    try { $cur[$p.Id] = $p.TotalProcessorTime.TotalSeconds } catch { }
  }
  $top = @()
  foreach ($procId in $cur.Keys) {
    $delta = $cur[$procId] - $prev[$procId]
    if ($delta -le 0) { continue }
    $totalDelta += $delta
    $pct = $delta / $elapsed * 100
    $top += [pscustomobject]@{ Id = $procId; Pct = $pct }
    if ($pct -ge $CpuThreshold) {
      $proc = $snapshot | Where-Object { $_.Id -eq $procId } | Select-Object -First 1
      $last = $lastHit[$procId]
      if (-not $last -or ($nowAt - $last).TotalSeconds -ge 30) {
        $lastHit[$procId] = $nowAt
        $ws = 0
        $nm = '<gone>'
        if ($proc) { $ws = $proc.WorkingSet64 / 1MB; $nm = $proc.ProcessName }
        Write-Hit $nm $procId $pct $ws
      }
    }
  }
  $sysPct = $totalDelta / $elapsed / $cores * 100
  if ($sysPct -ge $SysThreshold) {
    $lastSys = $lastHit['__sys__']
    if (-not $lastSys -or ($nowAt - $lastSys).TotalSeconds -ge 60) {
      $lastHit['__sys__'] = $nowAt
      $desc = ($top | Sort-Object Pct -Descending | Select-Object -First 8 | ForEach-Object { "{0}:{1}%" -f $_.Id, [math]::Round($_.Pct, 1) }) -join ' '
      $msg = "[{0}] system cpu {1}%  ->  {2}" -f $nowAt.ToString('yyyy-MM-dd HH:mm:ss'), [math]::Round($sysPct, 1), $desc
      Write-Host $msg -ForegroundColor Red
      Add-Content -Path $logPath -Value $msg -Encoding UTF8
    }
  }
  $prev = $cur
  $prevAt = $nowAt
}

Write-Host ""
Write-Host ("done: {0} rounds, {1} hits" -f $rounds, $hits) -ForegroundColor Cyan
if (Test-Path $csvPath) {
  Write-Host "--- summary ---" -ForegroundColor Cyan
  Import-Csv $csvPath | Group-Object Name | Sort-Object Count -Descending |
    Select-Object @{n='Process';e={$_.Name}}, @{n='Hits';e={$_.Count}},
                  @{n='MaxCpu';e={($_.Group | Measure-Object CPU_pct -Maximum).Maximum}},
                  @{n='MaxWS_MB';e={($_.Group | Measure-Object WS_MB -Maximum).Maximum}} |
    Format-Table -AutoSize
}
