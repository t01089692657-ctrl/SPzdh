@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在从 npm 官方源下载 ffmpeg / ffprobe（Windows 64位静态版）...
echo 需要 Windows 10 以上（自带 curl 和 tar）。
echo.

mkdir bin\win32-x64 2>nul
mkdir _tmp 2>nul

curl -fL -o _tmp\ffmpeg.tgz https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz
if errorlevel 1 goto :fail
tar -xzf _tmp\ffmpeg.tgz -C _tmp
if errorlevel 1 goto :fail
copy /y _tmp\package\ffmpeg.exe bin\win32-x64\ffmpeg.exe >nul
if errorlevel 1 goto :fail
rmdir /s /q _tmp\package

curl -fL -o _tmp\ffprobe.tgz https://registry.npmjs.org/@ffprobe-installer/win32-x64/-/win32-x64-5.1.0.tgz
if errorlevel 1 goto :fail
tar -xzf _tmp\ffprobe.tgz -C _tmp
if errorlevel 1 goto :fail
copy /y _tmp\package\ffprobe.exe bin\win32-x64\ffprobe.exe >nul
if errorlevel 1 goto :fail
rmdir /s /q _tmp\package
rmdir /s /q _tmp

if not exist bin\win32-x64\ffmpeg.exe goto :fail
if not exist bin\win32-x64\ffprobe.exe goto :fail

echo.
echo 完成！ffmpeg.exe / ffprobe.exe 已放入 deps\bin\win32-x64\
echo 重启平台后生效。
pause
exit /b 0

:fail
echo.
echo 下载失败。请检查网络，或手动下载 ffmpeg 放到 deps\bin\win32-x64\：
echo   https://www.gyan.dev/ffmpeg/builds/  （下载 release-essentials，解压 bin 目录里的 ffmpeg.exe / ffprobe.exe）
pause
exit /b 1
