const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pipeline } = require("stream");

const { loadConfig, root } = require("./lib/config");
const { sendJson, readJsonBody, mimeFor, safeChildPath, ensureDir, randomId } = require("./lib/utils");
const { Auth, httpError } = require("./lib/auth");
const { Records } = require("./lib/records");
const { Jobs } = require("./lib/jobs");
const { Providers, saveMediaInputs } = require("./lib/providers");
const { Media } = require("./lib/media");
const analysis = require("./lib/analysis");

const config = loadConfig();
const publicDir = path.join(root, "public");
ensureDir(config.dataDir);
ensureDir(config.uploadDir);
ensureDir(config.outputDir);

// 兜底：任何漏网的异步异常/未处理 Promise 都只记录日志，绝不让整台服务（含内存任务队列）崩掉下线。
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const auth = new Auth(config);
const records = new Records(config);
const providers = new Providers(config);
const media = new Media(config);
const jobs = new Jobs(config);

const JOB_TYPES = new Set(["kling", "jimeng", "edit", "codex_reference", "codex_product"]);
let statusCache = { at: 0, data: null };
let statusInFlight = null;

async function buildStatus(force) {
  const [engines, caps] = await Promise.all([
    providers.detectStatus(),
    media.detectCapabilities(force)
  ]);
  return {
    at: Date.now(),
    data: {
      engines,
      media: {
        available: caps.available,
        version: caps.version,
        source: caps.ffmpegSource,
        ffprobe: !!caps.ffprobe,
        xfade: caps.xfade,
        openMontage: media.openMontageAvailable()
      },
      analysis: {
        configured: !!config.analysis.apiKey,
        baseUrl: config.analysis.baseUrl,
        model: config.analysis.model
      },
      codex: {
        enabled: !!config.commands.codexEnabled
      },
      server: {
        platform: process.platform,
        node: process.version,
        host: config.host,
        port: config.port
      }
    }
  };
}

// ---------------- 任务执行器 ----------------

jobs.register("kling", "kling", async (job, { setProgress }) => {
  setProgress("正在提交可灵生成任务（可能需要几分钟）", 15);
  const result = await providers.generateKling(job.payload);
  setProgress("正在回存生成结果", 90);
  result.localUrl = await tryDownloadFirstWork(result.works, job.id, job.owner);
  return result;
});

jobs.register("jimeng", "jimeng", async (job, { setProgress }) => {
  setProgress("正在提交即梦生成任务（可能需要几分钟）", 15);
  const workDir = ensureDir(path.join(config.uploadDir, "jimeng", job.id));
  try {
    const result = await providers.generateJimeng(job.payload, workDir);
    setProgress("正在回存生成结果", 90);
    result.localUrl = await tryDownloadFirstWork(result.works, job.id, job.owner);
    return result;
  } finally {
    // 无论成功失败都清掉上传的素材临时目录，避免失败任务残留把迷你主机磁盘吃满
    cleanupDir(workDir);
  }
});

jobs.register("edit", "edit", async (job, { setProgress }) => {
  const payload = job.payload || {};
  const workDir = ensureDir(path.join(config.uploadDir, "edit", job.id));
  try {
    setProgress("正在接收素材", 5);
    const mediaOptions = { outputDir: config.outputDir, localHosts: localOutputHosts(), ownerSegment: safeUserSegment(job.owner) };
    const clipItems = [...(payload.clips || []), ...(payload.generatedVideos || [])];
    const clips = await saveMediaInputs(clipItems, workDir, "clip", mediaOptions);
    const references = await saveMediaInputs(payload.referenceVideos || [], workDir, "reference", mediaOptions);
    if (!clips.length) throw httpError(400, "请先上传至少一个素材视频，或先生成一个视频结果。");

    const outputDir = ensureDir(path.join(userOutputDir(job.owner), "edit"));
    const output = path.join(outputDir, `${job.id}.mp4`);
    const resolution = payload.ratio === "16:9" ? "1920x1080" : payload.ratio === "1:1" ? "1080x1080" : "1080x1920";
    const options = {
      clips: clips.map((item) => item.path),
      reference: references[0]?.path || "",
      output,
      transition: payload.transition || "crossfade",
      transitionDuration: Number(payload.transitionDuration || 0.35),
      resolution,
      workDir,
      onProgress: setProgress
    };

    let result;
    let engine = "builtin-ffmpeg";
    if (config.editor.preferOpenMontage && media.openMontageAvailable()) {
      setProgress("正在调用 OpenMontage 剪辑", 20);
      try {
        result = await media.stitchWithOpenMontage(options);
        engine = "openmontage";
      } catch (error) {
        setProgress("OpenMontage 失败，切换内置 ffmpeg 引擎", 25);
        result = await media.stitch(options);
        result.notes = [`OpenMontage 执行失败（${error.message}），已改用内置 ffmpeg 引擎。`, ...(result.notes || [])];
      }
    } else {
      result = await media.stitch(options);
    }

    return {
      ok: true,
      provider: engine,
      url: toPublicOutput(output),
      duration: result.duration,
      transition: result.transition,
      notes: result.notes || []
    };
  } finally {
    // 成功/失败都清中间产物（源素材、归一化、转场临时文件），避免磁盘被吃满
    cleanupDir(workDir);
  }
});

jobs.register("codex_reference", "codex", (job, { setProgress }) => runCodex(job, setProgress));
jobs.register("codex_product", "codex", (job, { setProgress }) => runCodex(job, setProgress));

async function runCodex(job, setProgress) {
  setProgress("Codex 正在分析素材（可能需要几分钟）", 20);
  const result = await providers.runCodexJob(job.id, job.type, job.payload || {});
  // 成功后清掉该 Codex 任务目录（素材/日志/中间文件），避免 data/codex-jobs 无限增长。
  // 失败时保留目录，便于管理员查看 codex-stderr.log 排查。
  cleanupDir(path.join(config.codexJobDir, job.id));
  return { ok: true, analysis: result.analysis };
}

async function tryDownloadFirstWork(works, jobId, owner) {
  try {
    const first = (works || [])[0] || {};
    const url = first.url || first.url_without_watermark || first.resource_url || "";
    if (!/^https?:\/\//i.test(url)) return "";
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) return "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = ensureDir(path.join(userOutputDir(owner), "generated"));
    const filePath = path.join(dir, `${jobId}.mp4`);
    fs.writeFileSync(filePath, buffer);
    return toPublicOutput(filePath);
  } catch {
    return "";
  }
}

function toPublicOutput(filePath) {
  const relative = path.relative(config.outputDir, filePath).replace(/\\/g, "/");
  return "/outputs/" + relative.split("/").map(encodeURIComponent).join("/");
}

// 成品按属主分目录存放：data/outputs/<用户>/...，配合 /outputs 服务时的属主校验做隔离。
function safeUserSegment(username) {
  return String(username || "unknown").replace(/[^\w一-龥.-]+/g, "_") || "unknown";
}

function userOutputDir(username) {
  return path.join(config.outputDir, safeUserSegment(username));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

// ---------------- HTTP 服务 ----------------

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(`[server] ${req.method} ${req.url} ->`, error);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: error.message || "服务器内部错误。" });
    else res.end();
  }
});

async function route(req, res) {
  const rawPath = (req.url || "/").split("?")[0];
  let urlPath;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    // 畸形百分号编码：返回 400 而不是让 URIError 冒泡成 500
    throw httpError(400, "请求路径编码无效。");
  }
  const query = new URL(req.url || "/", "http://localhost").searchParams;

  if (urlPath === "/api/health") {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  if (urlPath.startsWith("/api/auth/")) {
    await handleAuthRoutes(req, res, urlPath);
    return;
  }

  if (urlPath.startsWith("/api/")) {
    const user = auth.sessionUser(req);
    if (!user) throw httpError(401, "请先登录。");
    await handleApiRoutes(req, res, urlPath, query, user);
    return;
  }

  if (urlPath.startsWith("/outputs/")) {
    const user = auth.sessionUser(req);
    if (!user) {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }
    // 属主隔离：先把路径归一化解析出真实文件位置，再判断它是否落在“该用户的目录”内。
    // 只比对 URL 字面首段是不够的——/outputs/自己/../别人/... 归一化后会跳进别人目录却通过字面校验。
    const relative = urlPath.replace(/^\/outputs\//, "");
    const resolved = safeChildPath(config.outputDir, relative);
    if (!resolved) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (user.role !== "admin") {
      const userDir = path.join(config.outputDir, safeUserSegment(user.username));
      if (resolved !== userDir && !resolved.startsWith(userDir + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
    }
    serveFile(res, config.outputDir, relative);
    return;
  }

  serveStatic(req, res, urlPath);
}

// ---------------- 认证路由 ----------------

async function handleAuthRoutes(req, res, urlPath) {
  const ip = req.socket.remoteAddress || "unknown";

  if (urlPath === "/api/auth/login" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: 64 * 1024 });
    const { token, user } = auth.login(payload.username, payload.password, ip);
    setSessionCookie(res, token);
    sendJson(res, 200, { ok: true, user });
    return;
  }

  if (urlPath === "/api/auth/register" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: 64 * 1024 });
    const user = auth.register(payload);
    const login = auth.login(payload.username, payload.password, ip);
    setSessionCookie(res, login.token);
    sendJson(res, 200, { ok: true, user });
    return;
  }

  if (urlPath === "/api/auth/logout" && req.method === "POST") {
    const user = auth.sessionUser(req);
    if (user) auth.logout(user.token);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (urlPath === "/api/auth/me" && req.method === "GET") {
    const user = auth.sessionUser(req);
    if (!user) throw httpError(401, "未登录。");
    sendJson(res, 200, {
      ok: true,
      user: { username: user.username, displayName: user.displayName, role: user.role },
      registrationOpen: !!config.registration.inviteCode
    });
    return;
  }

  if (urlPath === "/api/auth/password" && req.method === "POST") {
    const user = auth.sessionUser(req);
    if (!user) throw httpError(401, "请先登录。");
    const payload = await readJsonBody(req, { limit: 64 * 1024 });
    // 已登录用户改密：用非限流的凭据校验，避免输错旧密码把自己的 IP 计入登录失败限流被锁在门外
    if (!auth.verifyCredential(user.username, payload.oldPassword)) {
      throw httpError(401, "当前密码不正确。");
    }
    auth.setPassword(user.username, payload.newPassword);
    const fresh = auth.login(user.username, payload.newPassword, req.socket.remoteAddress || "unknown");
    setSessionCookie(res, fresh.token);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlPath === "/api/auth/registration" && req.method === "GET") {
    sendJson(res, 200, { ok: true, open: !!config.registration.inviteCode });
    return;
  }

  throw httpError(404, "接口不存在。");
}

function setSessionCookie(res, token) {
  const maxAge = config.session.ttlHours * 3600;
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`);
}

// ---------------- 业务路由 ----------------

async function handleApiRoutes(req, res, urlPath, query, user) {
  const bodyLimit = config.limits.bodyLimitMb * 1024 * 1024;

  if (urlPath === "/api/status" && req.method === "GET") {
    const force = query.get("refresh") === "1";
    if (!statusCache.data || force || Date.now() - statusCache.at > 60_000) {
      // single-flight：并发/连点刷新时只跑一次检测，其余请求复用同一个进行中的 Promise，
      // 否则每个请求都会 spawn kling/dreamina/codex 探测子进程，形成子进程风暴拖垮迷你主机。
      if (!statusInFlight) {
        statusInFlight = buildStatus(force).finally(() => { statusInFlight = null; });
      }
      statusCache = await statusInFlight;
    }
    sendJson(res, 200, { ok: true, ...statusCache.data, queues: jobs.queueSummary() });
    return;
  }

  if (urlPath === "/api/analyze/product" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: bodyLimit });
    const result = await analysis.analyzeProduct(config, payload);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (urlPath === "/api/analyze/reference" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: bodyLimit });
    const result = await analysis.analyzeReference(config, payload);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (urlPath === "/api/jobs" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: bodyLimit });
    const type = String(payload.type || "");
    if (!JOB_TYPES.has(type)) throw httpError(400, `任务类型无效：${type || "(空)"}`);
    if (type.startsWith("codex_") && !config.commands.codexEnabled) {
      throw httpError(403, "Codex 自动分析未启用。请管理员在 config.json 里设置 commands.codexEnabled=true（注意其安全风险）后再用。");
    }
    const job = await jobs.create(type, user.username, payload.payload || {}, {
      title: String(payload.title || "").slice(0, 80)
    });
    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (urlPath === "/api/jobs" && req.method === "GET") {
    sendJson(res, 200, { ok: true, jobs: jobs.list(user, { all: query.get("all") === "1" }) });
    return;
  }

  const jobMatch = urlPath.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && req.method === "GET") {
    sendJson(res, 200, { ok: true, job: jobs.get(jobMatch[1], user) });
    return;
  }

  const recordsMatch = urlPath.match(/^\/api\/records\/(history|projects)(?:\/([A-Za-z0-9_.-]+))?$/);
  if (recordsMatch) {
    const [, kind, id] = recordsMatch;
    if (req.method === "GET" && !id) {
      sendJson(res, 200, { ok: true, records: records.list(user.username, kind) });
      return;
    }
    if (req.method === "POST" && !id) {
      const payload = await readJsonBody(req, { limit: bodyLimit });
      const saved = records.save(user.username, kind, payload.record);
      sendJson(res, 200, { ok: true, record: saved });
      return;
    }
    if (req.method === "DELETE" && id) {
      records.remove(user.username, kind, id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && !id) {
      records.clear(user.username, kind);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (urlPath.startsWith("/api/admin/")) {
    if (user.role !== "admin") throw httpError(403, "需要管理员权限。");
    await handleAdminRoutes(req, res, urlPath, user);
    return;
  }

  throw httpError(404, "接口不存在。");
}

async function handleAdminRoutes(req, res, urlPath, actor) {
  if (urlPath === "/api/admin/users" && req.method === "GET") {
    sendJson(res, 200, { ok: true, users: auth.listUsers() });
    return;
  }

  if (urlPath === "/api/admin/users" && req.method === "POST") {
    const payload = await readJsonBody(req, { limit: 64 * 1024 });
    const created = auth.createUser(payload);
    sendJson(res, 200, { ok: true, user: created });
    return;
  }

  const userMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)(?:\/(password|disable))?$/);
  if (userMatch) {
    const [, rawName, action] = userMatch;
    // urlPath 已在 route() 里 decodeURIComponent 过一次，这里直接用，避免二次解码把合法用户名弄坏
    const username = rawName;
    if (req.method === "POST" && action === "password") {
      const payload = await readJsonBody(req, { limit: 64 * 1024 });
      auth.setPassword(username, payload.password);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && action === "disable") {
      const payload = await readJsonBody(req, { limit: 64 * 1024 });
      auth.setDisabled(username, !!payload.disabled);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && !action) {
      auth.deleteUser(username, actor.username);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  throw httpError(404, "接口不存在。");
}

// ---------------- 静态资源 ----------------

// 默认拒绝：除白名单外的一切资源都要求登录。白名单小写匹配，避免 Windows/NTFS 大小写
// 不敏感文件系统上用 /INDEX.HTML、/Admin.Html 之类绕过鉴权。
const PUBLIC_ASSETS = new Set(["/login.html", "/styles.css", "/favicon.svg", "/favicon.ico"]);

function serveStatic(req, res, urlPath) {
  const target = urlPath === "/" ? "/index.html" : urlPath;
  // 去掉结尾的点/空格（Windows 会忽略它们从而命中真实文件），再统一小写比对白名单
  const normalized = target.replace(/[.\s]+$/, "").toLowerCase() || target.toLowerCase();

  if (!PUBLIC_ASSETS.has(normalized)) {
    const user = auth.sessionUser(req);
    if (!user) {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }
  }

  serveFile(res, publicDir, target.replace(/^\/+/, ""));
}

function serveFile(res, baseDir, relativePath) {
  const filePath = safeChildPath(baseDir, relativePath);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeFor(filePath),
      "Content-Length": stats.size,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff"
    });
    // pipeline 在源流出错或客户端提前断开时销毁两端，避免未捕获 error 崩进程、以及 fd 泄漏
    pipeline(fs.createReadStream(filePath), res, (error) => {
      if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE" && error.code !== "ECONNRESET") {
        console.error(`[serveFile] ${filePath}: ${error.message}`);
      }
    });
  });
}

// ---------------- 启动 ----------------

server.requestTimeout = 0;
server.headersTimeout = 120_000;

server.listen(config.port, config.host, async () => {
  const addresses = lanAddresses();
  console.log("======================================");
  console.log("  AI 视频创作平台 已启动");
  console.log(`  本机访问:   http://127.0.0.1:${config.port}/`);
  for (const address of addresses) {
    console.log(`  局域网访问: http://${address}:${config.port}/`);
  }
  console.log("  员工用局域网地址即可在自己电脑/手机上使用");
  console.log("======================================");
  const caps = await media.detectCapabilities();
  console.log(caps.available
    ? `[media] ffmpeg 可用（${caps.ffmpegSource}）${caps.xfade ? "，支持交叉淡化转场" : "，将使用黑场转场（无 xfade）"}`
    : "[media] 未找到 ffmpeg —— 剪辑功能不可用，请查看 deps/README.md");
});

function lanAddresses() {
  if (!["0.0.0.0", "::"].includes(config.host)) return [config.host];
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) list.push(entry.address);
    }
  }
  return list;
}

// 允许作为“同源 /outputs”本地读取的主机名：本机地址 + 所有局域网网卡地址。
function localOutputHosts() {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!["0.0.0.0", "::"].includes(config.host)) hosts.add(config.host);
  for (const address of lanAddresses()) hosts.add(address);
  return [...hosts];
}
