@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================= 依赖自检 =================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [缺失] Node.js —— 必装！请到 https://nodejs.org/zh-cn 安装 18+
) else (
  for /f "delims=" %%v in ('node --version') do echo [正常] Node.js %%v
)

if exist "bin\win32-x64\ffmpeg.exe" (
  echo [正常] ffmpeg（随包附带 deps\bin\win32-x64）
) else (
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo [缺失] ffmpeg —— 智能剪辑不可用。运行 get-ffmpeg.bat 补装
  ) else (
    echo [正常] ffmpeg（系统 PATH）
  )
)

where kling >nul 2>nul
if errorlevel 1 (
  echo [可选] kling CLI 未安装 —— 可灵真实生成不可用
) else (
  echo [正常] kling CLI 已安装（登录状态请在管理后台查看）
)

where dreamina >nul 2>nul
if errorlevel 1 (
  where bash.exe >nul 2>nul
  if errorlevel 1 (
    echo [可选] dreamina CLI 未安装 —— 即梦真实生成不可用
  ) else (
    echo [可选] dreamina 可能装在 WSL 内，登录状态请在管理后台查看
  )
) else (
  echo [正常] dreamina CLI 已安装
)

where codex >nul 2>nul
if errorlevel 1 (
  echo [可选] Codex CLI 未安装 —— “交给Codex”不可用
) else (
  echo [正常] Codex CLI 已安装
)

if exist "..\config.json" (
  echo [正常] config.json 已创建
) else (
  echo [提示] 还没有 config.json —— 需要视觉分析时，复制 config.example.json 为 config.json 并填 apiKey
)

echo.
echo 检测完成。详细登录状态请启动平台后进 管理后台 查看。
pause
