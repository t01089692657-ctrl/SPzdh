#!/usr/bin/env bash
# 补装 ffmpeg：优先系统包管理器（版本新、支持 xfade），失败则下载静态版到 deps/bin
set -e
cd "$(dirname "$0")"

if command -v apt-get >/dev/null 2>&1; then
  echo "尝试用 apt 安装新版 ffmpeg（需要 sudo）..."
  if sudo apt-get update && sudo apt-get install -y ffmpeg; then
    echo "完成！系统 ffmpeg：$(ffmpeg -version | head -1)"
    exit 0
  fi
elif command -v yum >/dev/null 2>&1; then
  echo "尝试用 yum 安装 ffmpeg（需要 sudo）..."
  sudo yum install -y ffmpeg && exit 0
elif command -v brew >/dev/null 2>&1; then
  echo "尝试用 Homebrew 安装 ffmpeg..."
  brew install ffmpeg && exit 0
fi

echo "包管理器安装失败，改为从 npm 官方源下载静态版..."
mkdir -p bin/linux-x64 _tmp
curl -L -o _tmp/ffmpeg.tgz https://registry.npmjs.org/@ffmpeg-installer/linux-x64/-/linux-x64-4.1.0.tgz
tar -xzf _tmp/ffmpeg.tgz -C _tmp
cp _tmp/package/ffmpeg bin/linux-x64/ffmpeg
rm -rf _tmp/package
curl -L -o _tmp/ffprobe.tgz https://registry.npmjs.org/@ffprobe-installer/linux-x64/-/linux-x64-5.1.0.tgz
tar -xzf _tmp/ffprobe.tgz -C _tmp
cp _tmp/package/ffprobe bin/linux-x64/ffprobe
rm -rf _tmp
chmod +x bin/linux-x64/ffmpeg bin/linux-x64/ffprobe
echo "完成！已放入 deps/bin/linux-x64/，重启平台后生效。"
