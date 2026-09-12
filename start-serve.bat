@echo off
REM ---------------------------------------------------------------------------
REM openai-subscription-gateway launcher (Windows)
REM Binds the gateway to the WSL vEthernet IP so clients inside WSL
REM (e.g. DSH at http://<ip>:10101/v1) can reach it.
REM For Windows-only clients use plain: node dist\cli\index.js serve
REM (that binds 127.0.0.1 only).
REM ---------------------------------------------------------------------------
cd /d "%~dp0"

for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -like '*WSL*' } | Select-Object -First 1).IPAddress"`) do set WSL_IP=%%i

if "%WSL_IP%"=="" (
  echo [ERROR] WSL vEthernet IP not found.
  echo         Run: ipconfig ^| findstr /C:"vEthernet"
  echo         then: set OSG_HOST=^<that IP^> ^&^& node dist\cli\index.js serve
  pause
  exit /b 1
)

echo Binding gateway to %WSL_IP%:10101  (WSL clients: http://%WSL_IP%:10101/v1)
set OSG_HOST=%WSL_IP%
node dist\cli\index.js serve
pause
