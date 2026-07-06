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

echo "包管理器安装失败，改为从 npm 官方源下载对应平台的静态版..."

# 识别系统与架构，选对应的 npm 包（Node 用的命名：linux/darwin + x64/arm64）
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *)      echo "不支持的系统：$(uname -s)。请手动安装 ffmpeg 到系统 PATH。"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *)             echo "不支持的架构：$(uname -m)。请手动安装 ffmpeg 到系统 PATH。"; exit 1 ;;
esac
PLAT="${OS}-${ARCH}"

TARGET="bin/${PLAT}"
mkdir -p "$TARGET" _tmp
echo "目标平台：${PLAT}"
if ! curl -fL -o _tmp/ffmpeg.tgz "https://registry.npmjs.org/@ffmpeg-installer/${PLAT}/-/${PLAT}-4.1.0.tgz"; then
  echo "下载 ffmpeg 失败（可能该平台无预编译包）。请用系统包管理器安装 ffmpeg。"; rm -rf _tmp; exit 1
fi
tar -xzf _tmp/ffmpeg.tgz -C _tmp
cp _tmp/package/ffmpeg "$TARGET/ffmpeg"
rm -rf _tmp/package
if ! curl -fL -o _tmp/ffprobe.tgz "https://registry.npmjs.org/@ffprobe-installer/${PLAT}/-/${PLAT}-5.1.0.tgz"; then
  echo "下载 ffprobe 失败。请用系统包管理器安装 ffmpeg。"; rm -rf _tmp; exit 1
fi
tar -xzf _tmp/ffprobe.tgz -C _tmp
cp _tmp/package/ffprobe "$TARGET/ffprobe"
rm -rf _tmp
chmod +x "$TARGET/ffmpeg" "$TARGET/ffprobe"
echo "完成！已放入 deps/${TARGET}/，重启平台后生效。"
