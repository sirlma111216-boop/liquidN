@echo off
chcp 65001 >nul
title 극저온의 세계 - 캠프 앱
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js 가 설치되어 있지 않습니다.
  echo       https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.
  echo.
  echo       * Node.js 없이 그냥 써도 됩니다. index.html 을 더블클릭하세요.
  echo         단, 그 경우에는 무선 센서 연결(블루투스)만 사용할 수 없습니다.
  echo.
  pause
  exit /b
)

node server.js
pause
