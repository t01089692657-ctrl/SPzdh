const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  referenceUrl: "",
  referenceKind: "",
  referenceFiles: [],
  referenceAnalysis: "",
  useReferenceAnalysis: false,
  avatarUrl: "",
  avatarKind: "",
  productImages: [],
  productAnalysis: "",
  editClips: [],
  resultUrl: "",
  outputType: "generation",
  script: ""
};

const stages = [
  ["分析参考视频结构", 16],
  ["提炼产品卖点", 32],
  ["匹配数字人口吻", 48],
  ["生成脚本与分镜", 66],
  ["渲染结果", 84],
  ["输出完成", 100]
];

const libraryCache = { history: [], projects: [] };

// ---------------- 基础工具 ----------------

function setProgress(label, value) {
  $("stageText").textContent = label;
  $("percentText").textContent = value + "%";
  $("progressBar").style.width = value + "%";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function revokeUrl(url) {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchApi(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    location.href = "/login.html";
    throw new Error("登录已过期，请重新登录。");
  }
  return response;
}

async function postJson(url, payload) {
  const response = await fetchApi(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "接口调用失败。");
  return data;
}

async function getJson(url) {
  const response = await fetchApi(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "接口调用失败。");
  return data;
}

async function deleteJson(url) {
  const response = await fetchApi(url, { method: "DELETE" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "接口调用失败。");
  return data;
}

// ---------------- 登录态 ----------------

async function loadMe() {
  try {
    const data = await getJson("/api/auth/me");
    state.user = data.user;
    $("userName").textContent = data.user.displayName || data.user.username;
    $("avatarInitial").textContent = (data.user.displayName || data.user.username).slice(0, 1).toUpperCase();
    if (data.user.role === "admin") $("adminLink").classList.remove("hidden");
  } catch {
    // fetchApi 401 已跳转
  }
}

$("logoutBtn").addEventListener("click", async () => {
  try {
    await postJson("/api/auth/logout", {});
  } catch {}
  location.href = "/login.html";
});

$("adminLink").addEventListener("click", () => {
  location.href = "/admin.html";
});

// ---------------- 任务轮询 ----------------

async function submitJob(type, payload, title) {
  const data = await postJson("/api/jobs", { type, payload, title });
  return data.job;
}

async function waitForJob(jobId, onProgress, { intervalMs = 3000, maxMinutes = 20 } = {}) {
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("等待任务超时，请稍后在服务器上查看任务状态。");
    await sleep(intervalMs);
    const data = await getJson(`/api/jobs/${jobId}`);
    const job = data.job;
    if (onProgress && job.progress) onProgress(job.progress.stage, job.progress.percent);
    if (job.status === "done") return job.result || {};
    if (job.status === "failed" || job.status === "interrupted") {
      throw new Error(job.error || "任务执行失败。");
    }
  }
}

// ---------------- 素材上传 ----------------

async function handleReferenceChange() {
  const file = $("referenceFile").files?.[0];
  if (!file) return;
  revokeUrl(state.referenceUrl);
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith("video/");
  state.referenceUrl = url;
  state.referenceKind = isVideo ? "video" : "image";
  state.referenceFiles = [{ name: file.name, type: file.type, dataUrl: await fileToDataUrl(file) }];
  $("referencePreview").innerHTML = `${isVideo ? `<video src="${url}" controls muted playsinline></video>` : `<img src="${url}" alt="参考素材预览" />`}<div class="file-name">${escapeHtml(file.name)}</div>`;
  $("referencePreview").classList.add("show");
  document.querySelector("#referenceDrop .upload-copy").classList.add("hidden");
}

async function handleAvatarChange() {
  const file = $("avatarFile").files?.[0];
  if (!file) return;
  revokeUrl(state.avatarUrl);
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith("video/");
  state.avatarUrl = url;
  state.avatarKind = isVideo ? "video" : "image";
  $("personPlaceholder").classList.add("hidden");
  $("avatarPreview").innerHTML = isVideo ? `<video src="${url}" controls muted playsinline></video>` : `<img src="${url}" alt="数字人预览" />`;
  $("avatarPreview").classList.add("show");
}

async function handleProductImages() {
  const files = [...($("productImages").files || [])].slice(0, 6);
  state.productImages = [];
  $("productImagePreview").innerHTML = "";
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    state.productImages.push({ name: file.name, type: file.type, dataUrl });
    const item = document.createElement("div");
    item.className = "thumb";
    item.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(file.name)}" />`;
    $("productImagePreview").appendChild(item);
  }
  const remain = Math.max(0, 3 - files.length);
  for (let i = 0; i < remain; i++) {
    const item = document.createElement("div");
    item.className = "thumb more-thumb";
    item.textContent = i === remain - 1 ? "›" : "图片";
    $("productImagePreview").appendChild(item);
  }
  $("imageCount").textContent = `(${files.length}/6)`;
}

async function handleEditClips() {
  const files = [...($("editClips").files || [])].slice(0, 8);
  state.editClips = [];
  for (const file of files) {
    state.editClips.push({ name: file.name, type: file.type, dataUrl: await fileToDataUrl(file) });
  }
  $("editClipCount").textContent = `(${files.length}/8)`;
  $("editClipPreview").textContent = files.length
    ? files.map((file, index) => `素材${index + 1}：${file.name}`).join("\n")
    : "上传多个视频素材后，可一键拼接、统一规格并加转场。";
  $("editClipPreview").classList.toggle("active", files.length > 0);
}

function getPlatforms() {
  const selected = [...document.querySelectorAll('input[name="platform"]:checked')].map((item) => item.value);
  return selected.length ? selected : ["视频号"];
}

function getProductName(info) {
  const first = info.split(/[\n，,。.;；]/).find(Boolean) || "你的产品";
  return first.length > 18 ? first.slice(0, 18) : first;
}

function setAnalysisBox(id, text, active = true) {
  $(id).textContent = text;
  $(id).classList.toggle("active", active);
  if (active) $(id).scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------- 视频关键帧抽取 ----------------

function captureVideoFrame(video, width = 768) {
  const ratio = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 16 / 9;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width * ratio);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("视频帧读取失败。"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), Math.max(video.duration - 0.1, 0));
  });
}

async function extractVideoFrames(fileItem, count = 6) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = fileItem.dataUrl;

    video.onloadedmetadata = async () => {
      try {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8;
        const frames = [];
        const frameCount = Math.min(count, Math.max(3, Math.ceil(duration / 4)));
        for (let i = 0; i < frameCount; i++) {
          const time = frameCount === 1 ? 0 : (duration * (i + 0.5)) / frameCount;
          await seekVideo(video, time);
          frames.push({
            name: `${fileItem.name}-frame-${i + 1}.jpg`,
            type: "image/jpeg",
            dataUrl: captureVideoFrame(video)
          });
        }
        resolve(frames);
      } catch (error) {
        reject(error);
      }
    };
    video.onerror = () => reject(new Error("浏览器无法读取这个视频文件，请换成 mp4/webm 或上传长图拆解。"));
  });
}

// ---------------- 参考素材拆解 ----------------

async function analyzeReference() {
  $("analyzeReferenceBtn").textContent = "正在拆解...";
  $("analyzeReferenceBtn").disabled = true;
  try {
    if (!state.referenceFiles.length) {
      setAnalysisBox("referenceAnalysis", "请先上传参考视频、参考图片或长图，再点击拆解。");
      return;
    }
    setAnalysisBox("referenceAnalysis", state.referenceKind === "video" ? "正在从参考视频抽取关键帧..." : "正在读取参考图片/长图...");
    const videoFrames = state.referenceKind === "video"
      ? await extractVideoFrames(state.referenceFiles[0], 6)
      : [];
    setAnalysisBox("referenceAnalysis", "正在调用视觉模型拆解参考素材...");
    const data = await postJson("/api/analyze/reference", {
      referenceKind: state.referenceKind,
      referenceFiles: state.referenceFiles,
      videoFrames,
      notes: $("referenceNotes").value.trim(),
      productInfo: $("productInfo").value.trim()
    });
    const meta = data.frames ? `\n\n分析来源：已读取 ${data.frames} 张${state.referenceKind === "video" ? "视频关键帧" : "参考图"}。` : "";
    state.referenceAnalysis = `${data.analysis}${meta}`;
    setAnalysisBox("referenceAnalysis", state.referenceAnalysis);
    $("analyzeReferenceBtn").textContent = "已拆解脚本";
    setTimeout(() => $("analyzeReferenceBtn").textContent = "拆解脚本", 1300);
  } catch (error) {
    setAnalysisBox("referenceAnalysis", error.message || "参考素材拆解失败。");
    $("analyzeReferenceBtn").textContent = "拆解失败";
    setTimeout(() => $("analyzeReferenceBtn").textContent = "拆解脚本", 1600);
  } finally {
    $("analyzeReferenceBtn").disabled = false;
  }
}

async function useReferenceAnalysis() {
  if (!state.referenceAnalysis) await analyzeReference();
  if (!state.referenceAnalysis) return;
  state.useReferenceAnalysis = true;
  $("scriptMode").value = "analysis";
  $("referenceAnalysis").textContent = state.referenceAnalysis + "\n\n已选择：生成时优先使用这份拆解脚本。";
  $("referenceAnalysis").classList.add("active");
}

// ---------------- Codex 分析 ----------------

async function sendToCodex(kind) {
  const isReference = kind === "reference";
  const btn = $(isReference ? "codexReferenceBtn" : "codexProductBtn");
  const box = isReference ? "referenceAnalysis" : "productAnalysis";
  btn.disabled = true;
  btn.textContent = "正在提交...";
  try {
    let payload;
    if (isReference) {
      if (!state.referenceFiles.length) {
        setAnalysisBox(box, "请先上传参考视频、参考图片或长图，再交给 Codex。");
        return;
      }
      setAnalysisBox(box, state.referenceKind === "video" ? "正在抽取视频关键帧并提交 Codex..." : "正在提交参考素材给 Codex...");
      const videoFrames = state.referenceKind === "video"
        ? await extractVideoFrames(state.referenceFiles[0], 8)
        : [];
      payload = {
        referenceKind: state.referenceKind,
        referenceFiles: state.referenceFiles,
        videoFrames,
        notes: $("referenceNotes").value.trim(),
        productInfo: $("productInfo").value.trim()
      };
    } else {
      if (!state.productImages.length) {
        setAnalysisBox(box, "请先上传产品图片，再交给 Codex。");
        return;
      }
      setAnalysisBox(box, "正在提交产品图片给 Codex...");
      payload = {
        productImages: state.productImages,
        productInfo: $("productInfo").value.trim()
      };
    }
    const job = await submitJob(isReference ? "codex_reference" : "codex_product", payload, "Codex 分析");
    setAnalysisBox(box, `已提交 Codex 自动分析（任务 ${job.id}），页面正在等待结果...`);
    btn.textContent = "等待Codex结果";
    const result = await waitForJob(job.id, null, { maxMinutes: 12 });
    const analysisText = result.analysis || "";
    if (analysisText) {
      if (isReference) {
        state.referenceAnalysis = analysisText;
      } else {
        state.productAnalysis = analysisText;
      }
      setAnalysisBox(box, analysisText);
    }
  } catch (error) {
    setAnalysisBox(box, error.message || "Codex 分析失败。");
  } finally {
    btn.disabled = false;
    setTimeout(() => btn.textContent = "交给Codex", 1500);
  }
}

// ---------------- 产品图分析 ----------------

function loadImageMeta(item) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ name: item.name, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ name: item.name, width: 0, height: 0 });
    image.src = item.dataUrl;
  });
}

async function analyzeProductImages() {
  $("analyzeProductBtn").textContent = "正在分析...";
  $("analyzeProductBtn").disabled = true;
  if (!state.productImages.length) {
    setAnalysisBox("productAnalysis", "请先上传产品图片，再点击分析。");
    $("analyzeProductBtn").textContent = "分析产品图片";
    $("analyzeProductBtn").disabled = false;
    return;
  }
  try {
    const metas = await Promise.all(state.productImages.map(loadImageMeta));
    setAnalysisBox("productAnalysis", `正在调用视觉模型分析 ${state.productImages.length} 张产品图片...\n${metas.map((item, index) => `图片${index + 1}：${item.name}，${item.width}x${item.height}`).join("\n")}`);
    const data = await postJson("/api/analyze/product", {
      productImages: state.productImages,
      productInfo: $("productInfo").value.trim()
    });
    state.productAnalysis = data.analysis;
    setAnalysisBox("productAnalysis", state.productAnalysis);
    $("analyzeProductBtn").textContent = "已分析产品图片";
    setTimeout(() => $("analyzeProductBtn").textContent = "分析产品图片", 1300);
  } catch (error) {
    setAnalysisBox("productAnalysis", error.message || "产品图片分析失败。");
    $("analyzeProductBtn").textContent = "分析失败";
    setTimeout(() => $("analyzeProductBtn").textContent = "分析产品图片", 1600);
  } finally {
    $("analyzeProductBtn").disabled = false;
  }
}

function useProductAnalysis() {
  if (!state.productAnalysis) {
    analyzeProductImages();
    return;
  }
  const current = $("productInfo").value.trim();
  $("productInfo").value = (current ? `${current}\n\n` : "") + state.productAnalysis;
  updateDescCount();
  $("productInfo").scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateDescCount() {
  $("descCount").textContent = $("productInfo").value.length;
}

// ---------------- 脚本与生成 ----------------

function makeScript() {
  const productInfo = $("productInfo").value.trim() || "产品信息未填写";
  const productName = getProductName(productInfo);
  const platforms = getPlatforms().join("、");
  const duration = $("duration").value;
  const persona = $("avatarPersona").value.trim() || "专业、自然、有信任感的数字人口播";
  const scriptMode = $("scriptMode").value;
  const useAnalysis = scriptMode === "analysis" || (scriptMode === "auto" && state.referenceAnalysis && state.useReferenceAnalysis);
  return [
    `项目：${productName}｜${platforms}｜${duration}秒`,
    "",
    useAnalysis ? "参考拆解脚本：" : "视频结构：",
    useAnalysis ? state.referenceAnalysis : "前3秒抓注意力，中段展示产品和信任证据，结尾引导私信询盘。",
    "",
    "数字人设定：",
    persona,
    "",
    "口播脚本：",
    "开头：你是不是也遇到过客户问了很多，但最后还是不敢下单？",
    `承接：今天用 ${productName} 这个产品，把客户最关心的问题讲清楚。`,
    "展示：镜头给到产品整体、细节和使用场景，突出一个最核心卖点。",
    "信任：补充工厂、质检、包装、交付或客户案例，让客户知道你是稳定供应商。",
    "结尾：想要完整资料和报价，直接私信我。"
  ].join("\n");
}

function makeVideoPrompt(scriptText) {
  return [
    `Create a vertical ${$("ratio").value} social commerce video for ${getPlatforms().join(", ")}.`,
    `Style: ${$("style").value}.`,
    `Digital human/persona: ${$("avatarPersona").value.trim() || "professional presenter"}.`,
    `Product information: ${$("productInfo").value.trim()}.`,
    state.productImages.length ? `Use ${state.productImages.length} uploaded product images as product visual references.` : "",
    state.referenceFiles.length ? `Use uploaded reference material for pacing and structure. Type: ${state.referenceKind}.` : "",
    "Avoid fake logos, unreadable text, deformed faces or hands.",
    "Script:",
    scriptText
  ].filter(Boolean).join("\n");
}

async function callRealEngine(engine, scriptText) {
  const payload = {
    prompt: makeVideoPrompt(scriptText),
    model: $("klingModel").value,
    jimengModel: $("jimengModel").value,
    duration: $("duration").value,
    resolution: $("resolution").value,
    ratio: $("ratio").value,
    productImages: state.productImages,
    referenceVideos: state.referenceKind === "video" ? state.referenceFiles : []
  };
  const job = await submitJob(engine, payload, getProductName($("productInfo").value.trim() || "视频生成"));
  return waitForJob(job.id, (stage, percent) => setProgress(stage, Math.max(88, percent)), { maxMinutes: 15 });
}

function renderScript(scriptText) {
  $("scriptOutput").textContent = scriptText;
  $("scriptOutput").classList.remove("hidden");
}

function renderRemoteResult(data, scriptText) {
  const works = Array.isArray(data.works) ? data.works : [];
  const first = works[0] || {};
  const url = data.localUrl || first.url || first.url_without_watermark || first.resource_url || "";
  const cover = first.cover_url || first.cover_url_without_watermark || "";
  const scriptBlob = new Blob([scriptText], { type: "text/plain;charset=utf-8" });
  const scriptUrl = URL.createObjectURL(scriptBlob);
  const note = data.note ? `<div class="status-line">${escapeHtml(data.note)}</div>` : "";
  $("result").innerHTML = url
    ? `<div><video src="${escapeHtml(url)}" poster="${escapeHtml(cover)}" controls playsinline></video><div class="download-row"><a class="btn primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开视频</a><a class="btn" href="${escapeHtml(url)}" download="AI生成结果.mp4">下载视频</a><a class="btn" href="${scriptUrl}" download="视频脚本与分镜.txt">下载脚本</a></div>${note}</div>`
    : `<div class="empty-video">生成任务已返回，但没有找到视频链接。</div>`;
  state.resultUrl = url;
  state.outputType = "generation";
  renderScript(scriptText);
}

async function renderMockResult(scriptText) {
  const canvas = $("renderCanvas");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f6f8fc";
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = "#2563eb";
  ctx.fillRect(60, 80, 600, 92);
  ctx.fillStyle = "#fff";
  ctx.font = "700 36px Microsoft YaHei, PingFang SC";
  ctx.fillText("AI 视频创作样片", 96, 138);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(70, 230, 580, 620);
  ctx.fillStyle = "#e9eef7";
  ctx.fillRect(110, 285, 500, 500);
  if (state.productImages[0]) {
    const image = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = state.productImages[0].dataUrl;
    });
    if (image) {
      const ratio = Math.min(480 / image.width, 480 / image.height);
      const w = image.width * ratio;
      const h = image.height * ratio;
      ctx.drawImage(image, 360 - w / 2, 310, w, h);
    }
  }
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 42px Microsoft YaHei, PingFang SC";
  ctx.fillText(getProductName($("productInfo").value || "你的产品"), 90, 945);
  ctx.font = "400 27px Microsoft YaHei, PingFang SC";
  ctx.fillText("脚本、分镜和生成提示词已准备好", 90, 1002);
  ctx.fillStyle = "#2563eb";
  ctx.fillRect(90, 1080, 540, 12);
  state.resultUrl = canvas.toDataURL("image/png");
  state.outputType = "generation";
  $("result").innerHTML = `<img src="${state.resultUrl}" alt="AI 视频样片" />`;
  renderScript(scriptText);
}

// ---------------- 智能剪辑 ----------------

async function runEdit() {
  const generatedVideos = /^(https?:\/\/|\/outputs\/)/i.test(state.resultUrl)
    ? [{ url: new URL(state.resultUrl, location.origin).href, name: "generated-result.mp4", type: "video/mp4" }]
    : [];
  if (!state.editClips.length && !generatedVideos.length) {
    $("openMontageStatus").textContent = "请先上传素材视频，或先生成一个真实视频结果。";
    return;
  }
  $("openMontageBtn").disabled = true;
  $("openMontageBtn").textContent = "剪辑中...";
  $("openMontageStatus").textContent = "已提交剪辑任务，可能需要 1-5 分钟...";
  try {
    const job = await submitJob("edit", {
      clips: state.editClips,
      generatedVideos,
      referenceVideos: state.referenceKind === "video" ? state.referenceFiles : [],
      transition: $("editTransition").value,
      transitionDuration: $("editTransitionDuration").value,
      ratio: $("ratio").value
    }, "智能剪辑");
    const data = await waitForJob(job.id, (stage) => {
      $("openMontageStatus").textContent = stage;
    }, { maxMinutes: 20 });
    state.resultUrl = data.url;
    state.outputType = "edit";
    const notes = (data.notes || []).join("；");
    $("result").innerHTML = `<div><video src="${escapeHtml(data.url)}" controls playsinline></video><div class="download-row"><a class="btn primary" href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">预览/打开剪辑视频</a><a class="btn" href="${escapeHtml(data.url)}" download="智能剪辑结果.mp4">下载剪辑视频</a></div></div>`;
    $("openMontageStatus").textContent = `剪辑完成${data.duration ? `：约 ${Math.round(data.duration)} 秒` : ""}${notes ? `（${notes}）` : ""}`;
    await saveRecord("history");
    await saveRecord("projects");
  } catch (error) {
    $("openMontageStatus").textContent = error.message || "剪辑失败。";
  } finally {
    $("openMontageBtn").disabled = false;
    $("openMontageBtn").textContent = "开始智能剪辑";
  }
}

// ---------------- 历史 / 项目（服务端存储） ----------------

function getProjectTypeMeta(type) {
  const value = type === "edit" ? "edit" : "generation";
  return value === "edit"
    ? { value, label: "剪辑项目", className: "edit" }
    : { value, label: "生成项目", className: "generation" };
}

function makeRecord(kind) {
  const productInfo = $("productInfo").value.trim();
  const scriptText = state.script || makeScript();
  const projectType = getProjectTypeMeta(state.outputType).value;
  const title = getProductName(productInfo || state.productAnalysis || scriptText || "未命名项目");
  return {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    kind,
    title,
    projectType,
    time: new Date().toLocaleString("zh-CN"),
    engine: $("engine").value,
    duration: $("duration").value,
    platforms: getPlatforms(),
    productInfo,
    productAnalysis: state.productAnalysis,
    referenceAnalysis: state.referenceAnalysis,
    useReferenceAnalysis: state.useReferenceAnalysis,
    persona: $("avatarPersona").value.trim(),
    script: scriptText,
    resultUrl: state.resultUrl
  };
}

async function saveRecord(kind) {
  const record = makeRecord(kind);
  try {
    await postJson(`/api/records/${kind}`, { record });
    await refreshLibraries();
  } catch (error) {
    console.warn("保存记录失败", error);
  }
  return record;
}

async function refreshLibraries() {
  try {
    const [history, projects] = await Promise.all([
      getJson("/api/records/history"),
      getJson("/api/records/projects")
    ]);
    libraryCache.history = history.records || [];
    libraryCache.projects = projects.records || [];
  } catch (error) {
    console.warn("读取记录失败", error);
  }
  renderRecordList("history");
  renderRecordList("projects");
}

function renderRecordList(kind) {
  const listId = kind === "projects" ? "projectList" : "historyList";
  const items = libraryCache[kind] || [];
  if (!items.length) {
    $(listId).innerHTML = `<div class="record-item"><div class="record-title">${kind === "projects" ? "还没有保存项目" : "还没有历史记录"}</div><div class="record-meta">在工作台生成或保存后，这里会自动出现记录。</div><div class="record-actions"><button class="btn primary" data-view-target="workspace" type="button">回到工作台</button></div></div>`;
    return;
  }
  $(listId).innerHTML = items.map((item) => {
    const typeMeta = getProjectTypeMeta(item.projectType);
    return `
    <article class="record-item">
      <div class="record-badge ${typeMeta.className}">${typeMeta.label}</div>
      <div class="record-title">${escapeHtml(item.title || "未命名项目")}</div>
      <div class="record-meta">${escapeHtml(item.time || "")}<br>${escapeHtml((item.platforms || []).join("、") || "未选择平台")}｜${escapeHtml(item.duration || "-")}秒｜${escapeHtml(item.engine || "mock")}</div>
      <div class="record-script">${escapeHtml((item.script || item.productInfo || "暂无脚本").slice(0, 420))}</div>
      <div class="record-actions">
        <button class="btn primary" data-load-record="${escapeHtml(item.id)}" data-kind="${kind}" type="button">加载</button>
        ${item.resultUrl ? `<a class="btn" href="${escapeHtml(item.resultUrl)}" target="_blank" rel="noreferrer">打开结果</a>` : ""}
        <button class="btn ghost" data-delete-record="${escapeHtml(item.id)}" data-kind="${kind}" type="button">删除</button>
      </div>
    </article>
  `;
  }).join("");
}

function showView(view) {
  const isWorkspace = view === "workspace";
  $("workspace").classList.toggle("library-mode", !isWorkspace);
  $("historyView").classList.toggle("hidden", view !== "history");
  $("projectsView").classList.toggle("hidden", view !== "projects");
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  if (!isWorkspace) refreshLibraries();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadRecord(id, kind) {
  const item = (libraryCache[kind] || []).find((record) => record.id === id);
  if (!item) return;
  $("productInfo").value = item.productInfo || "";
  $("avatarPersona").value = item.persona || "";
  state.productAnalysis = item.productAnalysis || "";
  state.referenceAnalysis = item.referenceAnalysis || "";
  state.useReferenceAnalysis = !!item.useReferenceAnalysis;
  state.script = item.script || "";
  state.resultUrl = item.resultUrl || "";
  state.outputType = getProjectTypeMeta(item.projectType).value;
  $("productAnalysis").textContent = state.productAnalysis || "已加载项目，可继续编辑产品描述。";
  $("productAnalysis").classList.add("active");
  $("referenceAnalysis").textContent = state.referenceAnalysis || "已加载项目，可重新上传参考视频拆解。";
  $("referenceAnalysis").classList.add("active");
  if (state.script) renderScript(state.script);
  if (state.resultUrl) {
    const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(state.resultUrl) || state.resultUrl.startsWith("http") || state.resultUrl.startsWith("/outputs/");
    const typeMeta = getProjectTypeMeta(state.outputType);
    const downloadName = typeMeta.value === "edit" ? "智能剪辑结果.mp4" : "AI生成结果.mp4";
    $("result").innerHTML = isVideo
      ? `<div><video src="${escapeHtml(state.resultUrl)}" controls playsinline></video><div class="download-row"><a class="btn primary" href="${escapeHtml(state.resultUrl)}" target="_blank" rel="noreferrer">预览/打开${typeMeta.label}</a><a class="btn" href="${escapeHtml(state.resultUrl)}" download="${downloadName}">下载结果</a></div></div>`
      : `<img src="${escapeHtml(state.resultUrl)}" alt="已加载结果" />`;
  }
  updateDescCount();
  showView("workspace");
}

async function deleteRecord(id, kind) {
  try {
    await deleteJson(`/api/records/${kind}/${encodeURIComponent(id)}`);
  } catch (error) {
    console.warn("删除记录失败", error);
  }
  await refreshLibraries();
}

// ---------------- 开始创作 ----------------

async function startGeneration() {
  if (!$("productInfo").value.trim() && !state.productAnalysis) {
    alert("请先填写产品描述，或上传产品图并分析。");
    return;
  }
  const engine = $("engine").value;
  if (engine !== "mock") {
    const name = engine === "kling" ? "可灵" : "即梦";
    if (!confirm(`你选择了${name}真实生成，这会提交任务并消耗公司账号的平台额度。确认开始吗？`)) return;
  }
  $("startBtn").disabled = true;
  $("result").innerHTML = `<div class="empty-video"><svg class="clap" viewBox="0 0 100 86" aria-hidden="true"><path fill="currentColor" d="M18 25h64a6 6 0 0 1 6 6v43a6 6 0 0 1-6 6H18a6 6 0 0 1-6-6V31a6 6 0 0 1 6-6Zm26 16v24l20-12-20-12ZM19 9l62-8 3 18-62 8-3-18Z"/></svg><div>正在生成...</div></div>`;
  for (const [label, value] of stages) {
    setProgress(label, value);
    await sleep(320);
  }
  const scriptText = makeScript();
  state.script = scriptText;
  try {
    if (engine === "mock") {
      await renderMockResult(scriptText);
    } else {
      setProgress(engine === "kling" ? "正在提交可灵生成任务" : "正在提交即梦生成任务", 88);
      const data = await callRealEngine(engine, scriptText);
      renderRemoteResult(data, scriptText);
    }
    await saveRecord("history");
    await saveRecord("projects");
    setProgress("已完成", 100);
  } catch (error) {
    $("result").innerHTML = `<div class="empty-video" style="color:var(--danger);">${escapeHtml(error.message)}</div>`;
    renderScript(scriptText);
    setProgress("生成失败", 100);
  } finally {
    $("startBtn").disabled = false;
  }
}

// ---------------- 引擎状态 ----------------

function pill(label, state) {
  const cls = state === true ? "ok" : state === "warn" ? "warn" : "bad";
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

async function loadEngineStatus() {
  try {
    const data = await getJson("/api/status");
    const models = data.engines?.kling?.textToVideoModels || [];
    if (models.length) {
      $("klingModel").innerHTML = models.map((item) => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.model)}${item.alias ? "｜" + escapeHtml(item.alias) : ""}</option>`).join("");
      if (models.some((item) => item.model === "kling-video-v3_0_turbo")) $("klingModel").value = "kling-video-v3_0_turbo";
    }
    const pills = [
      pill(data.analysis?.configured ? "拆解分析可用" : "拆解分析未配置", !!data.analysis?.configured),
      pill(data.engines?.kling?.authenticated ? "可灵已登录" : "可灵不可用", data.engines?.kling?.authenticated ? true : false),
      pill(data.engines?.jimeng?.configured ? "即梦已登录" : "即梦不可用", data.engines?.jimeng?.configured ? true : false),
      pill(data.media?.available ? "剪辑引擎就绪" : "剪辑引擎缺 ffmpeg", data.media?.available ? true : false),
      pill(data.engines?.codex?.installed ? "Codex 可用" : "Codex 未安装", data.engines?.codex?.installed ? true : "warn")
    ];
    $("enginePills").innerHTML = pills.join("");
    const jimengCredit = data.engines?.jimeng?.total_credit ? `，即梦余额 ${data.engines.jimeng.total_credit}` : "";
    $("engineStatus").textContent = `真实生成会消耗公司账号的平台额度${jimengCredit}。遇到引擎不可用请联系管理员。`;
  } catch (error) {
    $("engineStatus").textContent = "生成引擎状态检测失败，请刷新重试或联系管理员。";
  }
}

// ---------------- 事件绑定 ----------------

$("referenceFile").addEventListener("change", handleReferenceChange);
$("productImages").addEventListener("change", handleProductImages);
$("editClips").addEventListener("change", handleEditClips);
$("productInfo").addEventListener("input", updateDescCount);
$("changeAvatarBtn").addEventListener("click", () => $("avatarFile").click());
$("avatarBox").addEventListener("click", () => $("avatarFile").click());
$("avatarFile").addEventListener("change", handleAvatarChange);
$("analyzeReferenceBtn").addEventListener("click", analyzeReference);
$("useReferenceBtn").addEventListener("click", useReferenceAnalysis);
$("codexReferenceBtn").addEventListener("click", () => sendToCodex("reference"));
$("analyzeProductBtn").addEventListener("click", analyzeProductImages);
$("useProductBtn").addEventListener("click", useProductAnalysis);
$("codexProductBtn").addEventListener("click", () => sendToCodex("product"));
$("startBtn").addEventListener("click", startGeneration);
$("openMontageBtn").addEventListener("click", runEdit);
$("saveProjectBtn").addEventListener("click", async () => {
  state.script = state.script || makeScript();
  const record = await saveRecord("projects");
  $("saveProjectBtn").textContent = `已保存：${record.title}`;
  setTimeout(() => $("saveProjectBtn").textContent = "保存到我的项目", 1500);
});
$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("确认清空你的所有历史记录吗？")) return;
  await deleteJson("/api/records/history");
  await refreshLibraries();
});
$("clearProjectsBtn").addEventListener("click", async () => {
  if (!confirm("确认清空你的所有项目吗？")) return;
  await deleteJson("/api/records/projects");
  await refreshLibraries();
});
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});
document.addEventListener("click", (event) => {
  const viewTarget = event.target.closest("[data-view-target]");
  if (viewTarget) showView(viewTarget.dataset.viewTarget);
  const loadTarget = event.target.closest("[data-load-record]");
  if (loadTarget) loadRecord(loadTarget.dataset.loadRecord, loadTarget.dataset.kind);
  const deleteTarget = event.target.closest("[data-delete-record]");
  if (deleteTarget) deleteRecord(deleteTarget.dataset.deleteRecord, deleteTarget.dataset.kind);
});

loadMe();
refreshLibraries();
loadEngineStatus();
