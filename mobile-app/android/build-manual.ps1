$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $project 'app'
$srcMain = Join-Path $app 'src\main'
$buildRoot = Join-Path $project 'apk-build'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$build = Join-Path $buildRoot "run-$stamp"
$repoRoot = Resolve-Path (Join-Path $project '..\..')
$distMobile = Join-Path $repoRoot 'dist\mobile'
$compiled = Join-Path $build 'compiled.zip'
$gen = Join-Path $build 'gen'
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$unsigned = Join-Path $build 'dieyun-mobile-unsigned.apk'
$aligned = Join-Path $build 'dieyun-mobile-aligned.apk'
$keystore = Join-Path $buildRoot 'debug.keystore'
$propsPath = Join-Path $project 'gradle.properties'

function Read-Prop {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Default
  )
  if (-not (Test-Path $propsPath)) { return $Default }
  $line = Get-Content $propsPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
  if (-not $line) { return $Default }
  return (($line -split '=', 2)[1]).Trim()
}

$versionCode = Read-Prop 'MOBILE_VERSION_CODE' '1'
$versionName = Read-Prop 'MOBILE_VERSION_NAME' '0.0.1'
$updateBaseUrl = Read-Prop 'MOBILE_UPDATE_BASE_URL' 'http://192.168.31.62:3099/'
$apkName = "dieyun-mobile-$versionName.apk"
$signed = Join-Path $build $apkName

$androidHome = $env:ANDROID_HOME
if (-not $androidHome) {
  throw 'ANDROID_HOME is not set'
}

function Resolve-JavaHome {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
    return $env:JAVA_HOME
  }
  $studioJbr = 'C:\Program Files\Android\Android Studio\jbr'
  if (Test-Path (Join-Path $studioJbr 'bin\javac.exe')) { return $studioJbr }
  $javac = Get-Command javac -ErrorAction SilentlyContinue
  if ($javac) { return (Split-Path (Split-Path $javac.Source -Parent) -Parent) }
  throw 'JAVA_HOME / javac not found. Install Android Studio or JDK 17+.'
}

function Resolve-BuildToolsDir([string]$sdkRoot) {
  $root = Join-Path $sdkRoot 'build-tools'
  if (-not (Test-Path $root)) { throw "Missing build-tools under $sdkRoot" }
  $picked = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'aapt2.exe') } |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0.0' } } -Descending |
    Select-Object -First 1
  if (-not $picked) { throw 'No Android build-tools found (need aapt2/d8).' }
  return $picked.FullName
}

$javaHome = Resolve-JavaHome
$env:JAVA_HOME = $javaHome
$env:Path = "$(Join-Path $javaHome 'bin');$env:Path"

$buildTools = Resolve-BuildToolsDir $androidHome
$androidJar = Join-Path $androidHome 'platforms\android-34\android.jar'
if (-not (Test-Path $androidJar)) {
  throw "Missing $androidJar (install platforms;android-34 in SDK Manager)"
}
Write-Host "[apk-build] JAVA_HOME=$javaHome"
Write-Host "[apk-build] build-tools=$buildTools"
Write-Host "[apk-build] platform=android-34"
$libJars = Get-ChildItem -Path (Join-Path $app 'libs') -Filter *.jar -File -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
$javaClasspath = (@($androidJar) + @($libJars)) -join ';'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [object[]]$Arguments = @()
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
  }
}

function Resolve-PythonExe {
  $candidates = @()
  if ($env:PYTHON) { $candidates += $env:PYTHON }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
  )
  foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and $cmd.Source -notmatch 'WindowsApps') {
      $candidates += $cmd.Source
    }
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      & $path -c "import PIL" 2>$null
      if ($LASTEXITCODE -eq 0) { return $path }
    }
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  throw 'Python not found (need Python 3 + Pillow for generate-mobile-icons.py). Install from python.org and run: python -m pip install Pillow'
}

New-Item -ItemType Directory -Force -Path $buildRoot, $build | Out-Null
$iconScript = Join-Path $repoRoot 'scripts\generate-mobile-icons.py'
if (Test-Path $iconScript) {
  $pythonExe = Resolve-PythonExe
  & $pythonExe $iconScript
  if ($LASTEXITCODE -ne 0) { throw 'generate-mobile-icons.py failed' }
}
$resolvedBuild = (Resolve-Path $build).Path
$resolvedProject = (Resolve-Path $project).Path
if (-not $resolvedBuild.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean unexpected build dir: $resolvedBuild"
}
New-Item -ItemType Directory -Force -Path $gen, $classes, $dex | Out-Null

Invoke-Checked (Join-Path $buildTools 'aapt2.exe') @('compile', '--dir', (Join-Path $srcMain 'res'), '-o', $compiled)
Invoke-Checked (Join-Path $buildTools 'aapt2.exe') @(
  'link',
  '-o', $unsigned,
  '-I', $androidJar,
  '--manifest', (Join-Path $srcMain 'AndroidManifest.xml'),
  '--java', $gen,
  '--min-sdk-version', '26',
  '--target-sdk-version', '34',
  '--version-code', $versionCode,
  '--version-name', $versionName,
  $compiled
)

$javaFiles = @()
$javaFiles += Get-ChildItem -Path (Join-Path $srcMain 'java') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$javaFiles += Get-ChildItem -Path $gen -Recurse -Filter *.java | ForEach-Object { $_.FullName }
Invoke-Checked 'javac' (@('-encoding', 'UTF-8', '--release', '17', '-classpath', $javaClasspath, '-d', $classes) + $javaFiles)

$classFiles = Get-ChildItem -Path $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
Invoke-Checked (Join-Path $buildTools 'd8.bat') (@('--min-api', '26', '--output', $dex) + $classFiles + $libJars)
Invoke-Checked 'jar' @('uf', $unsigned, '-C', $dex, '.')
Invoke-Checked (Join-Path $buildTools 'zipalign.exe') @('-f', '4', $unsigned, $aligned)

if (-not (Test-Path $keystore)) {
  Invoke-Checked 'keytool' @(
    '-genkeypair',
    '-v',
    '-keystore', $keystore,
    '-storepass', 'android',
    '-alias', 'androiddebugkey',
    '-keypass', 'android',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US'
  )
}

Invoke-Checked (Join-Path $buildTools 'apksigner.bat') @(
  'sign',
  '--ks', $keystore,
  '--ks-pass', 'pass:android',
  '--key-pass', 'pass:android',
  '--out', $signed,
  $aligned
)
Invoke-Checked (Join-Path $buildTools 'apksigner.bat') @('verify', $signed)

New-Item -ItemType Directory -Force -Path $distMobile | Out-Null
Get-ChildItem -LiteralPath $distMobile -Filter 'dieyun-mobile-*.apk' -File -ErrorAction SilentlyContinue |
  Remove-Item -Force
Copy-Item -LiteralPath $signed -Destination (Join-Path $distMobile $apkName) -Force

$base = $updateBaseUrl.TrimEnd('/') + '/'
$manifest = [ordered]@{
  platform = 'android'
  packageName = 'com.dieyun.agent.mobile'
  versionCode = [int]$versionCode
  versionName = $versionName
  apk = $apkName
  url = $apkName
  minSdk = 26
  publishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $distMobile 'mobile-latest.json') -Encoding UTF8

Get-Item $signed, (Join-Path $distMobile $apkName), (Join-Path $distMobile 'mobile-latest.json') |
  Select-Object FullName, Length, LastWriteTime
