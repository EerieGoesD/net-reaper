@echo off
:: Package the Net Reaper browser extension for Chrome Web Store upload.
:: Produces net-reaper-extension.zip in this folder, excluding the native host files.

setlocal
set EXT_DIR=%~dp0
set OUT=%EXT_DIR%net-reaper-extension.zip

:: Delete old zip if exists
if exist "%OUT%" del "%OUT%"

:: Create zip using PowerShell (available on all modern Windows)
powershell -NoProfile -Command ^
  "Compress-Archive -Path '%EXT_DIR%manifest.json','%EXT_DIR%background.js','%EXT_DIR%popup.html','%EXT_DIR%popup.js','%EXT_DIR%icon-16.png','%EXT_DIR%icon-48.png','%EXT_DIR%icon-128.png' -DestinationPath '%OUT%'"

if exist "%OUT%" (
    echo.
    echo  [OK] Created: net-reaper-extension.zip
    echo  Upload this file to the Chrome Web Store Developer Dashboard.
    echo.
) else (
    echo.
    echo  [ERROR] Failed to create zip.
    echo.
)
pause
