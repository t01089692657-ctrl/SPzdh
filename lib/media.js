const fs = require("fs");
const path = require("path");
const { runCommand } = require("./providers");
const { ensureDir, parseJsonLoose } = require("./utils");
const { root } = require("./config");

const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

// ffmpeg / ffprobe 查找顺序：
// 1. config.json 里的 ffmpegPath / ffprobePath
// 2. 随包分发的 deps/bin/<platform>-<arch>/ 以及 deps/bin/
// 3. OpenMontage 自带的 .local-bin
// 4. 系统 PATH
class Media {
  constructor(config) {
    this.config = config;
    this.resolved = null;
    this.capabilities = null;
  }

  candidatePaths(tool) {
    const list = [];
    const configured = tool === "ffmpeg" ? this.config.ffmpegPath : this.config.ffprobePath;
    if (configured) list.push(configured);
    const platformDir = `${process.platform}-${process.arch}`;
    list.push(path.join(root, "deps", "bin", platformDir, tool + EXE));
    list.push(path.join(root, "deps", "bin", tool + EXE));
    if (this.config.openMontageRoot) {
      list.push(path.join(this.config.openMontageRoot, ".local-bin", tool + EXE));
    }
    list.push(tool); // PATH
    return list;
  }

  async resolveTools(force = false) {
    if (this.resolved && !force) return this.resolved;
    const found = { ffmpeg: "", ffprobe: "", ffmpegSource: "", ffprobeSource: "" };
    for (const tool of ["ffmpeg", "ffprobe"]) {
      for (const candidate of this.candidatePaths(tool)) {
        const isPathLookup = candidate === tool;
        if (!isPathLookup && !fs.existsSync(candidate)) continue;
        // Linux/macOS 上若解压工具丢了可执行位（且未经 start.sh chmod），随包 ffmpeg 会无法执行。
        // 直接 node server.js 启动也能自愈：探测前给随包二进制补上可执行位。
        if (!isPathLookup && !IS_WINDOWS) {
          try {
            fs.chmodSync(candidate, 0o755);
          } catch {
            // 无权限就跳过，继续按原样探测
          }
        }
        const probe = await runCommand(candidate, ["-version"], { timeoutMs: 15_000 });
        // 必须真正执行成功(exit 0)且自报为该工具，才算可用；坏二进制(错架构/缺库)会被跳过，
        // 继续尝试下一候选（含系统 PATH），而不是被误判为可用后阻断兜底。
        if (probe.ok && new RegExp(`${tool} version`, "i").test(`${probe.stdout}${probe.stderr}`)) {
          found[tool] = candidate;
          found[`${tool}Source`] = isPathLookup ? "PATH" : candidate;
          break;
        }
      }
    }
    this.resolved = found;
    return found;
  }

  async detectCapabilities(force = false) {
    if (this.capabilities && !force) return this.capabilities;
    const tools = await this.resolveTools(force);
    const caps = {
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      ffmpegSource: tools.ffmpegSource,
      ffprobeSource: tools.ffprobeSource,
      available: !!tools.ffmpeg,
      version: "",
      xfade: false,
      acrossfade: false
    };
    if (tools.ffmpeg) {
      const version = await runCommand(tools.ffmpeg, ["-version"], { timeoutMs: 15_000 });
      caps.version = (version.stdout.split("\n")[0] || "").trim();
      const filters = await runCommand(tools.ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 20_000 });
      const text = filters.stdout + filters.stderr;
      caps.xfade = /\bxfade\b/.test(text);
      caps.acrossfade = /\bacrossfade\b/.test(text);
    }
    this.capabilities = caps;
    return caps;
  }

  async probeClip(filePath) {
    const tools = await this.resolveTools();
    if (tools.ffprobe) {
      const result = await runCommand(tools.ffprobe, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath
      ], { timeoutMs: 60_000 });
      const parsed = parseJsonLoose(result.stdout);
      if (parsed) {
        const streams = parsed.streams || [];
        return {
          duration: Number(parsed.format?.duration || 0) || 0,
          hasAudio: streams.some((stream) => stream.codec_type === "audio"),
          hasVideo: streams.some((stream) => stream.codec_type === "video")
        };
      }
    }
    // 兜底：解析 ffmpeg -i 的 stderr
    if (tools.ffmpeg) {
      const result = await runCommand(tools.ffmpeg, ["-hide_banner", "-i", filePath], { timeoutMs: 60_000 });
      const text = result.stderr || "";
      const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
      return {
        duration,
        hasAudio: /Stream #.*Audio/.test(text),
        hasVideo: /Stream #.*Video/.test(text)
      };
    }
    return { duration: 0, hasAudio: false, hasVideo: false };
  }

  targetSize(resolution) {
    const map = { "1080x1920": [1080, 1920], "1920x1080": [1920, 1080], "1080x1080": [1080, 1080] };
    return map[resolution] || [1080, 1920];
  }

  // 规格统一：分辨率、帧率、像素格式、采样率；没有音轨的补静音，保证后续拼接不炸。
  async normalizeClip(input, output, { resolution = "1080x1920", fps = 30, crf = 22, preset = "medium", probe = null } = {}) {
    const tools = await this.resolveTools();
    if (!tools.ffmpeg) throw mediaError("没有可用的 ffmpeg。请查看 deps/README.md 安装，或在 config.json 配置 ffmpegPath。");
    const info = probe || await this.probeClip(input);
    if (!info.hasVideo) throw mediaError(`素材没有视频轨：${path.basename(input)}`);
    const [width, height] = this.targetSize(resolution);
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p,setsar=1`;

    const args = ["-y", "-i", input];
    if (!info.hasAudio) {
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    }
    args.push("-vf", vf);
    if (info.hasAudio) {
      // 有音轨素材：把音频补齐/裁到视频时长，保证单片段音画等长——否则接缝处会冻帧、转场淡出丢失
      args.push("-af", "aresample=async=1:first_pts=0,apad");
      args.push("-map", "0:v:0", "-map", "0:a:0?", "-shortest");
    } else {
      args.push("-map", "0:v:0", "-map", "1:a:0", "-shortest");
    }
    args.push(
      "-r", String(fps),
      "-c:v", "libx264",
      "-crf", String(crf),
      "-preset", preset,
      "-c:a", "aac",
      "-ar", "44100",
      "-ac", "2",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    );
    const result = await runCommand(tools.ffmpeg, args, { timeoutMs: 600_000 });
    if (!result.ok || !fs.existsSync(output)) {
      throw mediaError(`规格统一失败（${path.basename(input)}）：${tail(result.stderr)}`);
    }
    return output;
  }

  // 拼接主入口。transition: cut | fade | crossfade
  async stitch({ clips, output, transition = "crossfade", transitionDuration = 0.35, resolution = "1080x1920", fps = 30, crf = 22, preset = "medium", workDir, onProgress = () => {} }) {
    if (!clips.length) throw mediaError("没有可拼接的素材。");
    const caps = await this.detectCapabilities();
    if (!caps.available) throw mediaError("没有可用的 ffmpeg。请查看 deps/README.md 安装，或在 config.json 配置 ffmpegPath。");

    const notes = [];
    let effectiveTransition = ["cut", "fade", "crossfade"].includes(transition) ? transition : "crossfade";
    if (effectiveTransition === "crossfade" && !caps.xfade) {
      effectiveTransition = "fade";
      notes.push("当前 ffmpeg 版本不支持 xfade 交叉淡化，已自动降级为黑场淡入淡出。");
    }

    const tmpDir = ensureDir(path.join(workDir, "normalized"));
    const normalized = [];
    for (const [index, clip] of clips.entries()) {
      onProgress(`正在统一素材规格 ${index + 1}/${clips.length}`, 10 + Math.round((index / clips.length) * 40));
      const target = path.join(tmpDir, `norm_${String(index + 1).padStart(2, "0")}.mp4`);
      await this.normalizeClip(clip, target, { resolution, fps, crf, preset });
      const info = await this.probeClip(target);
      normalized.push({ path: target, duration: info.duration });
    }

    ensureDir(path.dirname(output));
    const td = Math.max(0.1, Math.min(2, Number(transitionDuration) || 0.35));

    if (normalized.length === 1) {
      fs.copyFileSync(normalized[0].path, output);
      return { output, transition: "none", notes, duration: normalized[0].duration };
    }

    onProgress("正在拼接输出", 60);
    if (effectiveTransition === "cut") {
      await this.concatEncode(normalized.map((item) => item.path), output, { fps, crf, preset });
    } else if (effectiveTransition === "fade") {
      await this.concatWithFade(normalized, output, workDir, td, { fps, crf, preset });
    } else {
      await this.concatWithXfade(normalized, output, td, { fps, crf, preset });
    }

    const finalInfo = await this.probeClip(output);
    return { output, transition: effectiveTransition, notes, duration: finalInfo.duration };
  }

  // 用 concat 滤镜（重新编码）无缝拼接。素材已统一规格，重编码一次即可消除
  // concat demuxer(-c copy) 在 AAC/MP4 接缝处的约 77ms 冻帧与音画错位。
  async concatEncode(files, output, { fps, crf, preset }) {
    const tools = await this.resolveTools();
    if (files.length === 1) {
      fs.copyFileSync(files[0], output);
      return;
    }
    const inputs = files.flatMap((file) => ["-i", file]);
    const streams = files.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("");
    const filter = `${streams}concat=n=${files.length}:v=1:a=1[vout][aout]`;
    const result = await runCommand(tools.ffmpeg, [
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", String(crf), "-preset", preset,
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      output
    ], { timeoutMs: 900_000 });
    if (!result.ok || !fs.existsSync(output)) throw mediaError(`拼接失败：${tail(result.stderr)}`);
  }

  // 黑场淡入淡出：在相邻片段的接缝处各做半段 fade，再无损级联。
  async concatWithFade(normalized, output, workDir, td, { fps, crf, preset }) {
    const tools = await this.resolveTools();
    const fadeDir = ensureDir(path.join(workDir, "faded"));
    const fadedFiles = [];
    for (const [index, item] of normalized.entries()) {
      const target = path.join(fadeDir, `fade_${String(index + 1).padStart(2, "0")}.mp4`);
      const vf = [];
      const af = [];
      if (index > 0) {
        vf.push(`fade=t=in:st=0:d=${td}`);
        af.push(`afade=t=in:st=0:d=${td}`);
      }
      if (index < normalized.length - 1 && item.duration > td) {
        const start = Math.max(0, item.duration - td);
        vf.push(`fade=t=out:st=${start.toFixed(3)}:d=${td}`);
        af.push(`afade=t=out:st=${start.toFixed(3)}:d=${td}`);
      }
      if (!vf.length) {
        fs.copyFileSync(item.path, target);
      } else {
        const result = await runCommand(tools.ffmpeg, [
          "-y", "-i", item.path,
          "-vf", vf.join(","),
          "-af", af.join(","),
          "-r", String(fps),
          "-c:v", "libx264", "-crf", String(crf), "-preset", preset,
          "-c:a", "aac", "-ar", "44100", "-ac", "2",
          "-pix_fmt", "yuv420p",
          target
        ], { timeoutMs: 600_000 });
        if (!result.ok || !fs.existsSync(target)) throw mediaError(`转场处理失败：${tail(result.stderr)}`);
      }
      fadedFiles.push(target);
    }
    await this.concatEncode(fadedFiles, output, { fps, crf, preset });
  }

  // 交叉淡化：xfade + acrossfade 滤镜图。
  async concatWithXfade(normalized, output, td, { fps, crf, preset }) {
    const tools = await this.resolveTools();
    const caps = await this.detectCapabilities();
    const inputs = normalized.flatMap((item) => ["-i", item.path]);
    const filters = [];
    let videoLabel = "[0:v]";
    let audioLabel = "[0:a]";
    let cumulative = normalized[0].duration;
    for (let i = 1; i < normalized.length; i++) {
      const offset = Math.max(0.1, cumulative - td);
      const vOut = i === normalized.length - 1 ? "[vout]" : `[v${i}]`;
      const aOut = i === normalized.length - 1 ? "[aout]" : `[a${i}]`;
      filters.push(`${videoLabel}[${i}:v]xfade=transition=fade:duration=${td}:offset=${offset.toFixed(3)}${vOut}`);
      if (caps.acrossfade) {
        filters.push(`${audioLabel}[${i}:a]acrossfade=d=${td}${aOut}`);
      } else {
        filters.push(`${audioLabel}[${i}:a]concat=n=2:v=0:a=1${aOut}`);
      }
      videoLabel = vOut;
      audioLabel = aOut;
      cumulative = offset + normalized[i].duration;
    }
    const result = await runCommand(tools.ffmpeg, [
      "-y", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", String(crf), "-preset", preset,
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    ], { timeoutMs: 900_000 });
    if (!result.ok || !fs.existsSync(output)) throw mediaError(`交叉淡化拼接失败：${tail(result.stderr)}`);
  }

  // OpenMontage（可选增强）：存在则可代替内置引擎执行拼接
  openMontageAvailable() {
    return !!(this.config.openMontageRoot && fs.existsSync(this.config.openMontageRoot));
  }

  pythonForOpenMontage() {
    if (this.config.commands.python) return this.config.commands.python;
    const venvPython = IS_WINDOWS
      ? path.join(this.config.openMontageRoot, ".venv", "Scripts", "python.exe")
      : path.join(this.config.openMontageRoot, ".venv", "bin", "python");
    if (fs.existsSync(venvPython)) return venvPython;
    return IS_WINDOWS ? "python" : "python3";
  }

  async stitchWithOpenMontage({ clips, reference, output, transition, transitionDuration, resolution, workDir }) {
    const plan = {
      openmontage_root: this.config.openMontageRoot,
      clips,
      reference: reference || "",
      output_path: output,
      transition: transition || "crossfade",
      transition_duration: Number(transitionDuration || 0.35),
      target_resolution: resolution,
      target_fps: 30,
      crf: 22,
      preset: "medium"
    };
    const planPath = path.join(workDir, "openmontage-plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
    const bridge = path.join(root, "tools", "openmontage_bridge.py");
    const result = await runCommand(this.pythonForOpenMontage(), ["-X", "utf8", bridge, planPath], { timeoutMs: 900_000 });
    const parsed = parseJsonLoose(result.stdout);
    if (!result.ok || !parsed?.success || !fs.existsSync(output)) {
      throw mediaError(`OpenMontage 剪辑失败：${tail(result.stderr) || parsed?.error || tail(result.stdout)}`);
    }
    return { output, transition: plan.transition, notes: ["由 OpenMontage 完成剪辑。"], duration: parsed.data?.duration || 0, data: parsed.data };
  }
}

function tail(text, length = 600) {
  const value = String(text || "").trim();
  return value.length > length ? `…${value.slice(-length)}` : value;
}

function mediaError(message) {
  const error = new Error(message);
  error.status = 500;
  return error;
}

module.exports = { Media };
