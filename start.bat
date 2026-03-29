@echo off
cd /d "%~dp0"
start "Clankers Web" cmd /k "node web/serve.js"
start "Clankers API" cmd /k "uvicorn api.main:app --reload --port 8000"
