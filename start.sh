#!/usr/bin/env bash
# AI 视频创作平台 - Linux/macOS 启动脚本
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js，请先安装 Node.js 18+："
  echo "  Ubuntu/Debian: sudo apt install -y nodejs npm"
  echo "  或访问 https://nodejs.org/zh-cn"
  exit 1
fi

chmod +x deps/bin/*/ffmpeg deps/bin/*/ffprobe deps/*.sh 2>/dev/null

# 缺少随包 ffmpeg 时（如拿到的是精简代码包），首次启动自动补装
ARCH_DIR="$(uname -s | tr 'A-Z' 'a-z')-$(case "$(uname -m)" in x86_64|amd64) echo x64;; arm64|aarch64) echo arm64;; *) echo x64;; esac)"
if [ ! -x "deps/bin/${ARCH_DIR}/ffmpeg" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未检测到 ffmpeg，正在自动安装（首次启动需联网）..."
  bash deps/get-ffmpeg.sh || echo "自动安装失败，智能剪辑将不可用；可稍后手动运行 deps/get-ffmpeg.sh。"
fi

echo "AI 视频创作平台正在启动..."
echo "初始管理员密码会打印在下方（也存在 data/初始管理员密码.txt）。"
exec node server.js
