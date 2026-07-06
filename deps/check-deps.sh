#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "================= 依赖自检 ================="
echo

if command -v node >/dev/null 2>&1; then
  echo "[正常] Node.js $(node --version)"
else
  echo "[缺失] Node.js —— 必装！Ubuntu/Debian: sudo apt install -y nodejs npm"
fi

case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) OS=linux ;; esac
case "$(uname -m)" in x86_64|amd64) A=x64 ;; arm64|aarch64) A=arm64 ;; *) A=x64 ;; esac
ARCH_DIR="${OS}-${A}"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "[正常] ffmpeg（系统 PATH，$(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)）"
elif [ -x "bin/${ARCH_DIR}/ffmpeg" ]; then
  echo "[正常] ffmpeg（随包附带 deps/bin/${ARCH_DIR}）"
else
  echo "[缺失] ffmpeg（本平台 ${ARCH_DIR}）—— 智能剪辑不可用。运行 ./get-ffmpeg.sh 补装"
fi

command -v kling >/dev/null 2>&1 && echo "[正常] kling CLI 已安装" || echo "[可选] kling CLI 未安装 —— 可灵真实生成不可用"
command -v dreamina >/dev/null 2>&1 && echo "[正常] dreamina CLI 已安装" || echo "[可选] dreamina CLI 未安装 —— 即梦真实生成不可用"
command -v codex >/dev/null 2>&1 && echo "[正常] Codex CLI 已安装" || echo "[可选] Codex CLI 未安装 —— “交给Codex”不可用"

if [ -f "../config.json" ]; then
  echo "[正常] config.json 已创建"
else
  echo "[提示] 还没有 config.json —— 需要视觉分析时，复制 config.example.json 为 config.json 并填 apiKey"
fi

echo
echo "检测完成。详细登录状态请启动平台后进 管理后台 查看。"
