@echo off
title RecordHub — Automated Session Recording
echo.
echo  ====================================
echo   RecordHub v1.0.0
echo   Automated Session Recording
echo  ====================================
echo.
echo  Dashboard:  http://localhost:3299
echo  Setup:      http://localhost:3299/setup
echo.
echo  Starting server...
echo.

cd /d "%~dp0"
start "RecordHub" node recordhub.js

timeout /t 3 /nobreak >nul

echo  Opening dashboard in browser...
start "" "http://localhost:3299"

echo.
echo  RecordHub is running. Close this window to stop.
pause
