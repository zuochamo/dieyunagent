@echo off
REM Full release entry (PC NSIS + Android + Y: + COS). Delegates to repo-root build-installer.bat.
REM
REM No argument: auto-detect the dev version (package.json) + 1 patch and hand it to the build as
REM the suggested unified PC / mobile release version. build-installer-ui.ps1 still shows that
REM suggestion and asks the operator to confirm (Enter = accept) before anything runs.
REM With an argument (build-installer-version.bat 0.1.36): pass through, no prompt.
REM Version parsing / suggestion: scripts/app-version.cjs -> scripts/resolve-next-version.cjs.
setlocal EnableExtensions

if not "%~1"=="" (
  call "%~dp0..\build-installer.bat" %*
  exit /b %ERRORLEVEL%
)

set "SUGGEST="
for /f "usebackq delims=" %%V in (`node "%~dp0resolve-next-version.cjs"`) do set "SUGGEST=%%V"

if not defined SUGGEST (
  echo [ERROR] Cannot auto-detect the version. Need Node.js and a "version" field in package.json.
  echo         Or pass it explicitly: build-installer-version.bat 0.1.36
  pause
  exit /b 1
)

call "%~dp0..\build-installer.bat" -SuggestedVersion %SUGGEST%
exit /b %ERRORLEVEL%
