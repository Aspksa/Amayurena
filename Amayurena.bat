@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node,10)>=20?0:1)"
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
echo Starting Amayurena...
node "%~dp0server.js"
if errorlevel 1 (
  echo Amayurena stopped with an error.
  pause
)
endlocal
