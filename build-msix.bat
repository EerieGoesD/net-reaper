@echo off
mkdir dist 2>nul
set MAKEPRI="C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makepri.exe"
%MAKEPRI% createconfig /cf "%~dp0priconfig.xml" /dq en-US /o >nul
if %errorlevel% neq 0 (
    echo FAILED: makepri createconfig
    pause
    exit /b 1
)
%MAKEPRI% new /pr "%~dp0msix" /cf "%~dp0priconfig.xml" /of "%~dp0msix\resources.pri" /o >nul
if %errorlevel% neq 0 (
    echo FAILED: makepri new
    pause
    exit /b 1
)
del "%~dp0priconfig.xml"
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\makeappx.exe" pack /d "%~dp0msix" /p "%~dp0dist\NetReaper_1.0.3.msix" /o /v
if %errorlevel% neq 0 (
    echo FAILED
    pause
) else (
    echo SUCCESS: dist\NetReaper_1.0.3.msix
)
