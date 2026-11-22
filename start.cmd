@echo off
setlocal
cd /d "%~dp0"
rem Uses agent.config.json beside this script; pass a different config path if needed.
node "%~dp0agent.mjs" %*
exit /b %errorlevel%
