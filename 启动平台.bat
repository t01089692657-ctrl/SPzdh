@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI 视频创作平台

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。
  echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/zh-cn
  echo 安装完成后重新双击本文件。
  pause
  exit /b 1
)

echo AI 视频创作平台正在启动...
echo 启动后请看下方提示的“局域网访问”地址，发给同事即可使用。
echo 初始管理员账号：admin / admin123 （请登录后立即修改密码）
echo.
node server.js
pause
