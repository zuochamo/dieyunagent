@echo off
REM Full release entry (PC NSIS + Android + Y: + COS). Delegates to repo-root build-installer.bat.
call "%~dp0..\build-installer.bat" %*
