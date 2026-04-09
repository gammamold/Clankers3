@echo off
echo Starting Clankers3...

start "Clankers3 API" cmd /k "cd /d %~dp0 && uvicorn api.main:app --port 8000"
timeout /t 2 /nobreak >nul

start "Clankers3 Frontend" cmd /k "cd /d %~dp0web && node serve.js"

echo.
echo API:      http://localhost:8000
echo Frontend: http://localhost:5174
echo.
pause
