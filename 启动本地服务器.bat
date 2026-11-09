@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   PokéBonk - 本地服务器
echo ============================================
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://127.0.0.1:8090/
  node server.cjs 8090
) else (
  echo 未找到 Node.js，请先安装：https://nodejs.org/
  pause
)
