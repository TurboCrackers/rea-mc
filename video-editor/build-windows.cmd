@echo off
rem Builds the Windows app into the dist folder. Needs Node.js from https://nodejs.org
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is needed to build. Get the LTS version from https://nodejs.org & pause & exit /b 1)
call npm install --no-audit --no-fund || (pause & exit /b 1)
call npm run dist || (pause & exit /b 1)
echo.
echo Done. The app is in the dist folder.
explorer dist
pause
