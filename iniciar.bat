@echo off
title R Editor Web
echo.
echo  ==========================================
echo   R Editor Web - Iniciando servidor...
echo  ==========================================
echo.
cd /d "%~dp0"
node server.js
pause
