@echo off
rem Runs Simple Video Editor from this folder. Needs Node.js from https://nodejs.org
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is needed to run from source. Get the LTS version from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo First start: downloading the editor's parts. This takes a minute...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
call npm start
