const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseJsonLoose, mimeToExt, sanitizeName, ensureDir, nowIso } = require("./utils");

const IS_WINDOWS = process.platform === "win32";

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs || 120_000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: -1, stdout, stderr: stderr || "命令执行超时。" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: error.message, errorCode: error.code || "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function shellQuote(args) {
  return args.map((arg) => {
    const text = String(arg);
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}

// Windows 下 CLI 通常是 .cmd/.bat 包装器，spawn 不带 shell 找不到，需经 cmd.exe。
function runCli(command, args, options = {}) {
  if (IS_WINDOWS) {
    return runCommand("cmd.exe", ["/d", "/s", "/c", command, ...args], options);
  }
  return runCommand(command, args, options);
}

class Providers {
  constructor(config) {
    this.config = config;
  }

  runKling(args, options = {}) {
    return runCli(this.config.commands.kling, args, options);
  }

  runDreamina(args, options = {}) {
    const command = this.config.commands.dreamina;
    if (IS_WINDOWS && this.config.commands.dreaminaViaWsl) {
      // 即梦 CLI 常装在 WSL 中，经 bash.exe 调用
      return runCommand("bash.exe", ["-lc", shellQuote([command, ...args])], options);
    }
    return runCli(command, args, options);
  }

  cleanError(result) {
    const message = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    return message || "命令执行失败。";
  }

  // ---------- 可灵 ----------

  normalizeKlingDuration(value) {
    const requested = Number(value || 5);
    if (requested <= 3) return "3";
    if (requested <= 5) return "5";
    if (requested <= 10) return "10";
    return "15";
  }

  async generateKling(payload) {
    const prompt = String(payload.prompt || "").trim();
    const model = String(payload.model || "kling-video-v3_0_turbo").trim();
    const duration = this.normalizeKlingDuration(payload.duration);
    const resolution = String(payload.resolution || "720p");
    const ratio = ["9:16", "16:9", "1:1"].includes(payload.ratio) ? payload.ratio : "9:16";

    if (!prompt) throw statusError(400, "缺少可灵文生视频 prompt。");

    const args = [
      "text_to_video",
      "--model", model,
      "--duration", duration,
      "--aspect_ratio", ratio,
      "--resolution", resolution,
      "--poll", "480",
      prompt
    ];

    const result = await this.runKling(args, { timeoutMs: 540_000 });
    const parsed = parseJsonLoose(result.stdout);
    if (!result.ok || !parsed) throw statusError(500, this.cleanError(result));

    return {
      ok: !!parsed.ok,
      provider: "kling",
      model,
      duration,
      note: Number(payload.duration) > Number(duration)
        ? `可灵当前单条视频按 ${duration} 秒生成；更长视频可先生成多段再用剪辑模块合成。`
        : "",
      generation_id: parsed.generation_id || parsed.body?.generation_id || parsed.body?.generationId || "",
      credits_consumed: parsed.credits_consumed || parsed.body?.credits_consumed || "",
      works: findWorks(parsed),
      raw: parsed
    };
  }

  // ---------- 即梦 ----------

  async generateJimeng(payload, workDir) {
    const prompt = String(payload.prompt || "").trim();
    if (!prompt) throw statusError(400, "缺少即梦生成 prompt。");

    const duration = Math.max(4, Math.min(15, Number(payload.duration || 5)));
    const resolution = String(payload.resolution || "720p");
    const model = String(payload.jimengModel || "seedance2.0fast");
    const ratio = ["9:16", "16:9", "1:1"].includes(payload.ratio) ? payload.ratio : "9:16";
    const productImages = saveDataFiles(payload.productImages, workDir, "product");
    const referenceVideos = saveDataFiles(payload.referenceVideos, workDir, "reference");

    let args;
    if (productImages.length || referenceVideos.length) {
      args = ["multimodal2video", "--prompt", prompt, "--duration", String(duration), "--ratio", ratio, "--model_version", model, "--video_resolution", resolution, "--poll", "480"];
      for (const image of productImages.slice(0, 9)) args.push("--image", this.pathForDreamina(image));
      for (const video of referenceVideos.slice(0, 3)) args.push("--video", this.pathForDreamina(video));
    } else {
      args = ["text2video", "--prompt", prompt, "--duration", String(duration), "--ratio", ratio, "--model_version", model, "--video_resolution", resolution, "--poll", "480"];
    }

    const result = await this.runDreamina(args, { timeoutMs: 540_000 });
    const parsed = parseJsonLoose(result.stdout);
    if (!result.ok || !parsed) throw statusError(500, this.cleanError(result));

    return {
      ok: true,
      provider: "jimeng",
      model,
      duration,
      works: findDreaminaWorks(parsed),
      raw: parsed
    };
  }

  pathForDreamina(filePath) {
    if (IS_WINDOWS && this.config.commands.dreaminaViaWsl) {
      const normalized = filePath.replace(/\\/g, "/");
      return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    }
    return filePath;
  }

  // ---------- Codex ----------

  makeCodexPrompt(job) {
    const productInfo = job.productInfo ? `\n产品信息：\n${job.productInfo}\n` : "";
    const notes = job.notes ? `\n用户补充：\n${job.notes}\n` : "";
    const assets = [
      ...job.assets.referenceFiles.map((item) => `- 参考素材：${item.path}`),
      ...job.assets.videoFrames.map((item) => `- 视频关键帧：${item.path}`),
      ...job.assets.productImages.map((item) => `- 产品图片：${item.path}`)
    ].join("\n");
    if (job.type === "codex_product") {
      return [
        "请你作为 Codex 视觉分析助手，分析这个本地任务里的产品图片。",
        "请基于图片真实内容输出中文产品信息，不能套模板；不确定处写“需确认”。",
        "你必须只返回符合 schema 的 JSON，不要输出 Markdown，不要解释执行过程。",
        productInfo,
        "素材路径：",
        assets || "无",
        "",
        "请输出：产品是什么、外观材质结构颜色、卖点、使用场景、视频镜头建议、可直接填入产品描述的文本。",
        "JSON 字段：ok=true，analysis=完整中文分析。"
      ].join("\n");
    }
    return [
      "请你作为 Codex 短视频拆解助手，分析这个本地任务里的参考视频关键帧/长图。",
      "请基于图片真实内容拆解脚本，不能套模板；看不清或缺失信息写“画面未能确认”。",
      "你必须只返回符合 schema 的 JSON，不要输出 Markdown，不要解释执行过程。",
      productInfo,
      notes,
      `素材类型：${job.referenceKind || "reference"}`,
      "素材路径：",
      assets || "无",
      "",
      "请输出：画面元素、开头钩子、节奏拆解、可复用结构、替换成我的产品的注意点、可直接生成视频的中文脚本草稿。",
      "JSON 字段：ok=true，analysis=完整中文拆解。"
    ].join("\n");
  }

  async runCodexJob(jobId, type, payload) {
    const dir = ensureDir(path.join(this.config.codexJobDir, jobId));
    const assetsDir = ensureDir(path.join(dir, "assets"));
    const resultPath = path.join(dir, "result.json");
    const job = {
      id: jobId,
      type,
      referenceKind: payload.referenceKind || "",
      notes: String(payload.notes || ""),
      productInfo: String(payload.productInfo || ""),
      assets: {
        referenceFiles: saveDataFiles(payload.referenceFiles, assetsDir, "reference"),
        videoFrames: saveDataFiles(payload.videoFrames, assetsDir, "frame"),
        productImages: saveDataFiles(payload.productImages, assetsDir, "product")
      }
    };
    const prompt = this.makeCodexPrompt(job);
    fs.writeFileSync(path.join(dir, "prompt.txt"), prompt, "utf8");

    const schemaPath = path.join(dir, "result-schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["ok", "analysis"],
      properties: {
        ok: { type: "boolean" },
        analysis: { type: "string" }
      }
    }, null, 2), "utf8");

    const imagePaths = [
      ...job.assets.productImages.map((item) => item.path),
      ...job.assets.videoFrames.map((item) => item.path),
      ...job.assets.referenceFiles
        .filter((item) => /\.(png|jpe?g|webp)$/i.test(item.path))
        .map((item) => item.path)
    ].slice(0, 10);

    if (!imagePaths.length) throw statusError(400, "没有可供 Codex 分析的图片素材。");

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C", dir,
      "--output-schema", schemaPath,
      "--output-last-message", resultPath,
      ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
      "-"
    ];

    const result = await new Promise((resolve) => {
      let child;
      const command = this.config.commands.codex;
      const spawnArgs = IS_WINDOWS ? ["/d", "/s", "/c", command, ...args] : args;
      const spawnCmd = IS_WINDOWS ? "cmd.exe" : command;
      try {
        child = spawn(spawnCmd, spawnArgs, { cwd: dir, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, code: -1, stderr: error.message });
        return;
      }
      const stdout = fs.createWriteStream(path.join(dir, "codex-stdout.log"), { flags: "a" });
      const stderrStream = fs.createWriteStream(path.join(dir, "codex-stderr.log"), { flags: "a" });
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderrStream);
      child.stdin.end(prompt, "utf8");
      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, code: -1, stderr: "Codex 执行超时（10 分钟）。" });
      }, 600_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stderr: stderrTail });
      });
    });

    if (fs.existsSync(resultPath)) {
      const parsed = parseJsonLoose(fs.readFileSync(resultPath, "utf8"));
      if (parsed?.analysis) return { analysis: parsed.analysis, dir };
    }
    throw statusError(500, `Codex 自动分析失败：${result.stderr || `退出码 ${result.code}`}。请确认服务器上已安装并登录 Codex CLI。`);
  }

  // ---------- 状态检测 ----------

  async detectStatus() {
    const [kling, dreamina] = await Promise.all([
      this.runKling(["who_am_i"], { timeoutMs: 30_000 }),
      this.runDreamina(["user_credit"], { timeoutMs: 30_000 })
    ]);
    const klingParsed = parseJsonLoose(kling.stdout);
    const dreaminaParsed = parseJsonLoose(dreamina.stdout);
    const models = klingParsed?.body?.available_models?.text_to_video?.models || [];
    const codex = await runCli(this.config.commands.codex, ["--version"], { timeoutMs: 20_000 });

    return {
      checkedAt: nowIso(),
      kling: {
        installed: kling.errorCode !== "ENOENT" && (kling.code !== -1 || !!kling.stdout || !!kling.stderr),
        authenticated: !!klingParsed?.ok,
        error: klingParsed?.ok ? "" : truncate(this.cleanError(kling), 400),
        textToVideoModels: models.map((model) => ({
          model: model.model,
          alias: model.alias,
          description: model.description
        }))
      },
      jimeng: {
        configured: !!dreaminaParsed?.user_id,
        command: this.config.commands.dreamina,
        total_credit: dreaminaParsed?.total_credit || "",
        vip_level: dreaminaParsed?.vip_level || "",
        error: dreaminaParsed?.user_id ? "" : truncate(this.cleanError(dreamina), 400)
      },
      codex: {
        installed: codex.ok,
        version: codex.ok ? truncate(codex.stdout.trim(), 80) : "",
        error: codex.ok ? "" : truncate(this.cleanError(codex), 200)
      }
    };
  }
}

function saveDataFiles(files, targetDir, prefix) {
  const saved = [];
  ensureDir(targetDir);
  for (const [index, file] of (files || []).entries()) {
    const dataUrl = String(file.dataUrl || "");
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;
    const mime = match[1];
    const ext = mimeToExt(mime, file.name);
    const safePrefix = String(prefix || "asset").replace(/[^\w-]+/g, "_");
    const safeName = sanitizeName(file.name, `${safePrefix}${ext}`);
    const filePath = path.join(targetDir, `${safePrefix}_${String(index + 1).padStart(2, "0")}_${safeName}${path.extname(safeName) ? "" : ext}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
    saved.push({
      name: file.name || path.basename(filePath),
      type: file.type || mime,
      path: filePath
    });
  }
  return saved;
}

async function saveMediaInputs(items, targetDir, prefix) {
  const saved = saveDataFiles(items, targetDir, prefix);
  for (const [index, item] of (items || []).entries()) {
    const url = String(item.url || item.resultUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const ext = path.extname(new URL(url).pathname) || ".mp4";
    const filePath = path.join(targetDir, `${prefix}_url_${index + 1}${ext}`);
    const response = await fetch(url);
    if (!response.ok) throw statusError(502, `下载远程素材失败：${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    saved.push({ name: item.name || path.basename(filePath), type: item.type || "video/mp4", path: filePath });
  }
  return saved;
}

function findWorks(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.works)) return value.works;
  for (const item of Object.values(value)) {
    const found = findWorks(item);
    if (found.length) return found;
  }
  return [];
}

function findDreaminaWorks(value) {
  const found = findWorks(value);
  if (found.length) return found;
  const urls = [];
  collectUrls(value, urls);
  return urls.map((url) => ({ url, content_type: /\.(mp4|mov|webm)(\?|$)/i.test(url) ? "video" : "image" }));
}

function collectUrls(value, urls) {
  if (!value) return;
  if (typeof value === "string" && /^https?:\/\//.test(value)) urls.push(value);
  if (Array.isArray(value)) value.forEach((item) => collectUrls(item, urls));
  if (typeof value === "object") Object.values(value).forEach((item) => collectUrls(item, urls));
}

function truncate(text, length) {
  const value = String(text || "");
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { Providers, runCommand, runCli, saveDataFiles, saveMediaInputs, findWorks, findDreaminaWorks, IS_WINDOWS };
