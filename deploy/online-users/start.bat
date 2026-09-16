@echo off
cd /d "%~dp0"
if not exist "node_modules\express" (
  echo 首次运行，正在安装依赖…
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
echo 启动工位监控: http://localhost:3003/api/users/online
node workplace-server.mjs
