#!/usr/bin/env bash
# AI 视频创作平台 - Linux/macOS 启动脚本
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js，请先安装 Node.js 18+："
  echo "  Ubuntu/Debian: sudo apt install -y nodejs npm"
  echo "  或访问 https://nodejs.org/zh-cn"
  exit 1
fi

chmod +x deps/bin/*/ffmpeg deps/bin/*/ffprobe 2>/dev/null

echo "AI 视频创作平台正在启动..."
echo "初始管理员账号：admin / admin123 （请登录后立即修改密码）"
exec node server.js
