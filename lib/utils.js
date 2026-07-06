const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8"
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJsonBody(req, { limit = 120 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        const error = new Error("请求内容过大，请压缩视频/图片后重试。");
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = new Error("请求内容不是有效 JSON。");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!aborted) reject(error);
    });
  });
}

function randomId(prefix = "") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}${stamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Resolve child under root; returns null when the path escapes root.
function safeChildPath(root, child) {
  const resolved = path.resolve(root, child);
  const rootResolved = path.resolve(root);
  if (resolved === rootResolved) return resolved;
  if (!resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseJsonLoose(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function mimeToExt(mime, name) {
  const byName = path.extname(String(name || ""));
  if (byName) return byName.toLowerCase();
  const text = String(mime || "");
  if (text.includes("png")) return ".png";
  if (text.includes("jpeg") || text.includes("jpg")) return ".jpg";
  if (text.includes("webp")) return ".webp";
  if (text.includes("gif")) return ".gif";
  if (text.includes("mp4")) return ".mp4";
  if (text.includes("quicktime")) return ".mov";
  if (text.includes("webm")) return ".webm";
  return ".bin";
}

function sanitizeName(name, fallback = "file") {
  // 除文件系统非法字符外，还剔除 cmd/shell 元字符——这些名字会成为 CLI 参数
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F&^%!$`;()\[\]{}=,'"]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

module.exports = {
  MIME_TYPES,
  mimeFor,
  sendJson,
  readJsonBody,
  randomId,
  nowIso,
  safeChildPath,
  ensureDir,
  parseJsonLoose,
  mimeToExt,
  sanitizeName
};
