@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-android.ps1" -NoBuild
if errorlevel 1 pause
