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
echo [NOTE] Monaco / Linux Node 请单独上传至 COS: npm run upload:optional-cos
echo.
echo [DONE] Published v%VER% to %DST%
echo.
endlocal
exit /b 0

:copy_fail
echo [ERROR] Copy failed
exit /b 1
