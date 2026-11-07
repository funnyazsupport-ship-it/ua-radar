@echo off
title UA-RADAR
cd /d "%~dp0"
echo.
echo   UA-RADAR - mapa povitryanykh tryvoh
echo   http://localhost:8787
echo.
start "" http://localhost:8787
node server.js
pause
