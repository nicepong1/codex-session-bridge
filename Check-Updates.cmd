@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0src\update-status.mjs"
echo.
pause
