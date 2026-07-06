const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const configPath = path.join(root, "config.json");
const examplePath = path.join(root, "config.example.json");

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    console.warn(`[config] 无法解析 ${path.basename(filePath)}：${error.message}`);
    return {};
  }
}

function loadConfig() {
  const example = readJsonFile(examplePath);
  const local = readJsonFile(configPath);
  const merged = deepMerge(example, local);

  const config = {
    host: process.env.HOST || merged.host || "0.0.0.0",
    port: Number(process.env.PORT || merged.port || 8781),
    dataDir: path.resolve(root, merged.dataDir || "data"),
    analysis: {
      apiKey: process.env.SAKAI_API_KEY || merged.analysis?.apiKey || "",
      baseUrl: process.env.SAKAI_BASE_URL || merged.analysis?.baseUrl || "https://sakai.my",
      model: process.env.SAKAI_MODEL || merged.analysis?.model || "gpt-5.5"
    },
    openMontageRoot: process.env.OPENMONTAGE_ROOT || merged.openMontageRoot || "",
    ffmpegPath: process.env.FFMPEG_PATH || merged.ffmpegPath || "",
    ffprobePath: process.env.FFPROBE_PATH || merged.ffprobePath || "",
    commands: {
      kling: merged.commands?.kling || "kling",
      dreamina: merged.commands?.dreamina || "dreamina",
      codex: merged.commands?.codex || "codex",
      python: merged.commands?.python || "",
      // Windows 上即梦 CLI 常安装在 WSL 里；true=通过 bash.exe 调用
      dreaminaViaWsl: merged.commands?.dreaminaViaWsl !== false
    },
    session: {
      ttlHours: Number(merged.session?.ttlHours || 72)
    },
    registration: {
      // 员工凭邀请码自助注册；留空则关闭自助注册，只能管理员开号
      inviteCode: String(merged.registration?.inviteCode || "")
    },
    editor: {
      // openmontage 存在时是否优先使用（false 则始终用内置 ffmpeg）
      preferOpenMontage: merged.editor?.preferOpenMontage !== false
    },
    limits: {
      bodyLimitMb: Number(merged.limits?.bodyLimitMb || 120),
      jobHistory: Number(merged.limits?.jobHistory || 200)
    }
  };

  config.uploadDir = path.join(config.dataDir, "uploads");
  config.outputDir = path.join(config.dataDir, "outputs");
  config.jobDir = path.join(config.dataDir, "jobs");
  config.codexJobDir = path.join(config.dataDir, "codex-jobs");
  return config;
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base === "object" && base && typeof extra === "object" && extra) {
    const out = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return extra ?? base;
}

module.exports = { loadConfig, root, configPath };
