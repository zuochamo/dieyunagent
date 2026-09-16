@echo off
REM Full release: Rust + Android + Y drive + COS
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-installer-ui.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] build-installer-ui.ps1 failed with exit code %EXITCODE%
  pause
)
exit /b %EXITCODE%
