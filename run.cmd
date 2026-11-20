@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22 or newer from https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node.js 22 or newer is required.'); process.exit(1); }"
if errorlevel 1 exit /b 1
if /i "%~1"=="install" goto dependencies
if not exist "%~dp0node_modules\@modelcontextprotocol\sdk\package.json" goto dependencies
if not exist "%~dp0node_modules\@iarna\toml\package.json" goto dependencies
if exist "%~dp0node_modules\zod\package.json" goto run
:dependencies
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js with npm.
  pause
  exit /b 1
)
pushd "%~dp0"
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  popd
  pause
  exit /b 1
)
popd
:run
node "%~dp0bin\bridge.mjs" %*
set "bridgeExit=%errorlevel%"
if "%~2"=="" pause
exit /b %bridgeExit%
