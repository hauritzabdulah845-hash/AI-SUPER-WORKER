@echo off
setlocal
title AI Super Employee - Dev Server
cd /d "%~dp0ai-super-employee"

echo ============================================
echo   AI Super Employee - Local Dev Launcher
echo   Project: %CD%
echo ============================================
echo.

rem ---------- locate npm.cmd as a FULL PATH (bare names break "call" resolution) ----------
set "NPM_CMD="
for /f "delims=" %%F in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%F"

if not defined NPM_CMD (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%D\npm.cmd" set "NPM_CMD=%%D\npm.cmd"
  )
)
if not defined NPM_CMD if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM_CMD if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NPM_CMD=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"

if not defined NPM_CMD (
  echo [Error] Node.js / npm not found.
  echo         Please install Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

rem ---------- put node into this session's PATH so vite and scripts can find it ----------
for %%F in ("%NPM_CMD%") do set "NODE_DIR=%%~dpF"
set "PATH=%NODE_DIR%;%PATH%"
echo [Node] %NPM_CMD%

if not exist "node_modules" (
  echo [Setup] node_modules not found, installing dependencies...
  echo         first run only, may take a few minutes
  call "%NPM_CMD%" install --no-audit --no-fund
  if errorlevel 1 (
    echo [Error] npm install failed. Check network / Node.js setup.
    pause
    exit /b 1
  )
  echo.
)

echo [Start] Launching dev server...
echo         Browser will open at http://localhost:5173/
echo         Press Ctrl+C in this window to stop the server.
echo.

rem ---------- wait for the dev server to be ready, then open the browser ----------
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process 'http://localhost:5173/';break}}catch{Start-Sleep -Seconds 1}}"

call "%NPM_CMD%" run dev -- --host :: --port 5173

echo.
echo [Stop] Dev server exited.
pause
