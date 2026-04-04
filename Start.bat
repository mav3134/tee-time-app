@echo off
title Tee Time App

:: Always run from the folder this batch file lives in
cd /d "%~dp0"

:: Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js is not installed.
    echo.
    echo  Please download and install it from:
    echo  https://nodejs.org
    echo.
    echo  Choose the "LTS" version, run the installer,
    echo  click Next through all the steps, then run this
    echo  file again.
    echo.
    pause
    exit /b
)

:: Install npm packages if node_modules doesn't exist
if not exist "node_modules" (
    echo.
    echo  First-time setup: installing packages...
    echo  This only happens once and takes about a minute.
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: npm install failed. Check your internet connection and try again.
        pause
        exit /b
    )
)

:: Install Playwright browser if not already installed
if not exist "node_modules\playwright\.local-browsers" (
    echo.
    echo  First-time setup: installing Chrome browser for Playwright...
    echo  This downloads about 150MB and only happens once.
    echo.
    call npx playwright install chromium
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: Playwright browser install failed.
        echo  Check your internet connection and try again.
        pause
        exit /b
    )
)

:: Start the server
echo.
echo  Starting Tee Time App...
echo  Opening your browser in a moment...
echo.
echo  To stop the app, close this window.
echo.

:: Open browser after a short delay
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Run the server
node server.js

:: If server exits, pause so user can see any error
echo.
echo  The app stopped. Press any key to close.
pause >nul
