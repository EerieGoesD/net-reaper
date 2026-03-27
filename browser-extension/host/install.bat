@echo off
setlocal EnableDelayedExpansion

echo.
echo  Net Reaper - Native Messaging Host Installer
echo  =============================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is required but not found.
    echo          Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Get the absolute path to this folder
set HOST_DIR=%~dp0
:: Remove trailing backslash
if "%HOST_DIR:~-1%"=="\" set HOST_DIR=%HOST_DIR:~0,-1%

echo  After loading the extension in Chrome/Edge:
echo    1. Go to chrome://extensions (or edge://extensions)
echo    2. Enable "Developer mode" (top-right)
echo    3. Click "Load unpacked" and select the browser-extension folder
echo    4. Copy the Extension ID shown under the extension name
echo.
set /p EXT_ID="  Paste your Extension ID here: "
if "!EXT_ID!"=="" (
    echo  [ERROR] No extension ID entered.
    pause
    exit /b 1
)

:: Write host manifest with correct absolute paths
echo {> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   "name": "com.eerie.net_reaper",>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   "description": "Net Reaper Download Manager",>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   "path": "%HOST_DIR:\=\\%\\net_reaper_host.bat",>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   "type": "stdio",>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   "allowed_origins": [>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo     "chrome-extension://!EXT_ID!/">> "%HOST_DIR%\com.eerie.net_reaper.json"
echo   ]>> "%HOST_DIR%\com.eerie.net_reaper.json"
echo }>> "%HOST_DIR%\com.eerie.net_reaper.json"

:: Register for Chrome
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.eerie.net_reaper" /ve /t REG_SZ /d "%HOST_DIR%\com.eerie.net_reaper.json" /f >nul 2>&1
echo  [OK] Registered for Chrome

:: Register for Edge
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.eerie.net_reaper" /ve /t REG_SZ /d "%HOST_DIR%\com.eerie.net_reaper.json" /f >nul 2>&1
echo  [OK] Registered for Edge

:: Register for Brave
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.eerie.net_reaper" /ve /t REG_SZ /d "%HOST_DIR%\com.eerie.net_reaper.json" /f >nul 2>&1
echo  [OK] Registered for Brave

echo.
echo  Done! Restart Chrome/Edge for changes to take effect.
echo.
pause
