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

rem 缺少随包 ffmpeg 时（如拿到的是精简代码包），首次启动自动联网补装
if not exist "deps\bin\win32-x64\ffmpeg.exe" (
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo 未检测到 ffmpeg，正在自动下载（首次启动需联网，约 1-2 分钟）...
    call "deps\get-ffmpeg.bat" </nul
  )
)

echo AI 视频创作平台正在启动...
echo 启动后请看下方提示的“局域网访问”地址，发给同事即可使用。
echo 初始管理员密码会打印在下方（也存在 data\初始管理员密码.txt）。
echo.
node server.js
pause
