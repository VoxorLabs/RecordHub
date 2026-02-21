@echo off
title RecordHub — Automated Session Recording
color 0A

echo.
echo  =========================================
echo   RecordHub v1.1.0
echo   Automated Session Recording for Events
echo  =========================================
echo.
echo  Dashboard : http://localhost:3299
echo  Setup     : http://localhost:3299/setup
echo.

:: Change to the directory this script lives in
cd /d "%~dp0"

:: Check Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js is not installed or not in PATH.
    echo.
    echo  Download Node.js from https://nodejs.org  (LTS version)
    echo  Then re-run this script.
    echo.
    pause
    exit /b 1
)

:: Auto-install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo  node_modules not found — running npm install...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
)

:: Open dashboard in the browser after a short delay (runs in background)
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:3299"

echo  Starting RecordHub...
echo  (Keep this window open — close it to stop the server)
echo.

:: Run Node in the foreground so closing this window stops the server
node recordhub.js

echo.
echo  RecordHub stopped.
pause
