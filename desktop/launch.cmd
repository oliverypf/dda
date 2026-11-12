@echo off
node "%~dp0scripts\launch-desktop.mjs" %*
if errorlevel 1 pause
