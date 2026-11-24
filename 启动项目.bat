@echo off
setlocal
title AI Super Employee - Dev Server
cd /d "%~dp0ai-super-employee"

echo ============================================
echo   AI Super Employee - Local Dev Launcher
echo   Project: %CD%
echo ============================================
echo.

rem ---------- locate npm: system PATH first, then known install locations ----------
set "NPM_CMD="
where npm >nul 2>nul && set "NPM_CMD=npm"

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
echo [Node] %NODE_DIR%

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

start "" cmd /c "timeout /t 6 /nobreak >nul & start "" http://localhost:5173/"

call "%NPM_CMD%" run dev -- --host 127.0.0.1 --port 5173

echo.
echo [Stop] Dev server exited.
pause
