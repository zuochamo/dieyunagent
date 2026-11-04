@echo off
setlocal

for /f "delims=" %%I in ('node "%~dp0resolve-build-dist.cjs"') do set "SRC=%%I"
set "MOBILE_SRC=%SRC%\mobile"
set "DST=Y:\client-electron\updates-published"

echo ========================================
echo  Dieyun Agent - Publish updates to Y:
echo ========================================
echo.

if not exist "%SRC%\latest.yml" (
  echo [ERROR] Missing %SRC%\latest.yml
  echo Run: npm run build:nsis
  exit /b 1
)

set "VER="
for /f "tokens=2 delims=: " %%V in ('findstr /B /C:"version:" "%SRC%\latest.yml"') do set "VER=%%V"

if not defined VER (
  echo [ERROR] Cannot read version from latest.yml
  exit /b 1
)

set "EXE=dieyunagent-Setup-%VER%.exe"
set "MAP=dieyunagent-Setup-%VER%.exe.blockmap"

if not exist "%SRC%\%EXE%" (
  echo [ERROR] Missing %SRC%\%EXE%
  exit /b 1
)
if not exist "%SRC%\%MAP%" (
  echo [ERROR] Missing %SRC%\%MAP%
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

echo [1/2] Clear %DST%
del /Q "%DST%\*.*" 2>nul

echo [2/2] Copy v%VER%
copy /Y "%SRC%\%EXE%" "%DST%\"
if errorlevel 1 goto :copy_fail
echo   OK %EXE%

copy /Y "%SRC%\%MAP%" "%DST%\"
if errorlevel 1 goto :copy_fail
echo   OK %MAP%

copy /Y "%SRC%\latest.yml" "%DST%\"
if errorlevel 1 goto :copy_fail
echo   OK latest.yml

rem Linux(Ubuntu) 自动更新：deb 与 latest-linux.yml 必须成对发布。
rem yml 只在同名 deb 存在时才拷（顺序 deb 先、yml 后），避免更新源里出现
rem 「yml 指向没打出来的安装包」——那会让 Ubuntu 端下载直接 404。
set "DEB=dieyunagent_%VER%_amd64.deb"
if exist "%SRC%\%DEB%" (
  copy /Y "%SRC%\%DEB%" "%DST%\"
  if errorlevel 1 goto :copy_fail
  echo   OK %DEB%
  if exist "%SRC%\latest-linux.yml" (
    copy /Y "%SRC%\latest-linux.yml" "%DST%\"
    if errorlevel 1 goto :copy_fail
    echo   OK latest-linux.yml
  )
) else (
  echo [WARN] 本次没有 Linux 安装包（未配构建机或 -SkipDeb）：发布后更新源不再提供 deb / latest-linux.yml
  echo        Ubuntu 端将收不到更新，需要重打 deb 后再发布一次。
)

if exist "%MOBILE_SRC%\mobile-latest.json" (
  copy /Y "%MOBILE_SRC%\mobile-latest.json" "%DST%\"
  if errorlevel 1 goto :copy_fail
  echo   OK mobile-latest.json
  for %%A in ("%MOBILE_SRC%\dieyun-mobile-*.apk") do (
    if exist "%%~fA" (
      copy /Y "%%~fA" "%DST%\"
      if errorlevel 1 goto :copy_fail
      echo   OK %%~nxA
    )
  )
  if exist "D:\opencode\dieyunagent\assets\icon.png" (
    copy /Y "D:\opencode\dieyunagent\assets\icon.png" "%DST%\dieyun-mobile-icon.png"
    if errorlevel 1 goto :copy_fail
    echo   OK dieyun-mobile-icon.png
  )
) else (
  echo [WARN] Mobile update manifest not found: %MOBILE_SRC%\mobile-latest.json
  echo        Run mobile-app\android\build-manual.ps1 to generate mobile APK update files.
)

echo.
echo.
echo [DONE] Published v%VER% to %DST%
echo.
endlocal
exit /b 0

:copy_fail
echo [ERROR] Copy failed
exit /b 1
