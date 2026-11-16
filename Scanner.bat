@echo off
title Document Scanner
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies... & call npm install)
echo.
echo  Document Scanner running at http://localhost:5317
echo  Close this window to stop it.
echo.
call npm start
