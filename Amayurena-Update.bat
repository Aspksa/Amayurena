@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required.
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node,10)>=20?0:1)"
if errorlevel 1 (
  echo Node.js 20+ is required.
  pause
  exit /b 1
)
echo Checking verified updates from the official GitHub release...
node "%~dp0update-worker.js" install
if errorlevel 1 (
  echo Update was not applied. See the error above.
  pause
  exit /b 1
)
endlocal
