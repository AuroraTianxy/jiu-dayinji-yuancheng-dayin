@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer first.
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  exit /b 1
)
call npm ci --omit=dev
if errorlevel 1 exit /b 1
if not defined REMOTE_PRINT_TOKEN if not exist "%~dp0agent.token" (
  if not exist "%~dp0set-token.cmd" (
    echo Run set-token.cmd to create a private token file, then rerun setup.cmd.
    exit /b 1
  )
  call "%~dp0set-token.cmd"
  if errorlevel 1 exit /b 1
)
node "%~dp0agent.mjs" --setup %*
exit /b %errorlevel%
