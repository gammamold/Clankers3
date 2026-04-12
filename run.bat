@echo off
echo Starting Clankers3 Frontend...

start "Clankers3 Frontend" cmd /k "cd /d %~dp0web && node serve.js"

echo.
echo Frontend: http://localhost:5174
echo.
pause
