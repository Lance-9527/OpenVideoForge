@echo off
chcp 65001 >nul
title OpenVideoForge
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js。请先安装 Node 18+：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动 OpenVideoForge（页面 + 桥）...
echo 关闭本窗口即停止服务。
node bin\cli.mjs open
pause