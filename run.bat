@echo off
rem Inicia o monitor dos inversores e a API HTTP em http://localhost:8080/status
cd /d "%~dp0"
python inverter_monitor.py --interval 30 --http 8080
