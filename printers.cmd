@echo off
setlocal
cd /d "%~dp0"
node "%~dp0agent.mjs" --printers
exit /b %errorlevel%
