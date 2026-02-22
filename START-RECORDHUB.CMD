@echo off
title RecordHub
cd /d "%~dp0"

echo.
echo  =========================================
echo   RecordHub
echo   Dashboard : http://localhost:3299
echo   Setup     : http://localhost:3299/setup
echo  =========================================
echo.

node recordhub.js

echo.
echo  RecordHub stopped.
pause
