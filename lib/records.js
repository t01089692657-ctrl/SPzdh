const path = require("path");
const { JsonStore } = require("./store");
const { httpError } = require("./auth");

const KINDS = new Set(["history", "projects"]);
const MAX_RECORDS = 50;
// 本地模拟结果是 data:image PNG，直接入库会让每用户 JSON 膨胀。放宽到 1.5MB，
// 覆盖绝大多数模拟预览图；真实生成/剪辑结果是短 URL，永远保留不受此限。
const MAX_RESULT_URL = 1500 * 1024;

class Records {
  constructor(config) {
    this.dir = path.join(config.dataDir, "records");
  }

  storeFor(username) {
    const safe = String(username).replace(/[^\w一-龥.-]+/g, "_");
    return new JsonStore(path.join(this.dir, `${safe}.json`), { history: [], projects: [] });
  }

  assertKind(kind) {
    if (!KINDS.has(kind)) throw httpError(400, "记录类型无效。");
  }

  list(username, kind) {
    this.assertKind(kind);
    return this.storeFor(username).read()[kind] || [];
  }

  save(username, kind, record) {
    this.assertKind(kind);
    if (!record || typeof record !== "object") throw httpError(400, "记录内容无效。");
    const cleaned = sanitizeRecord(record);
    this.storeFor(username).update((data) => {
      const items = Array.isArray(data[kind]) ? data[kind] : [];
      data[kind] = [cleaned, ...items.filter((item) => item.id !== cleaned.id)].slice(0, MAX_RECORDS);
    });
    return cleaned;
  }

  remove(username, kind, id) {
    this.assertKind(kind);
    this.storeFor(username).update((data) => {
      data[kind] = (data[kind] || []).filter((item) => item.id !== id);
    });
  }

  clear(username, kind) {
    this.assertKind(kind);
    this.storeFor(username).update((data) => {
      data[kind] = [];
    });
  }
}

function sanitizeRecord(record) {
  const resultUrl = String(record.resultUrl || "");
  // id 限定为删除路由能匹配的字符集，避免出现“能存但删不掉”的记录
  const rawId = String(record.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const id = (rawId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64)) || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return {
    id,
    title: String(record.title || "未命名项目").slice(0, 120),
    projectType: record.projectType === "edit" ? "edit" : "generation",
    time: String(record.time || new Date().toLocaleString("zh-CN")).slice(0, 40),
    engine: String(record.engine || "mock").slice(0, 24),
    duration: String(record.duration || "").slice(0, 8),
    platforms: Array.isArray(record.platforms) ? record.platforms.map((item) => String(item).slice(0, 20)).slice(0, 8) : [],
    productInfo: String(record.productInfo || "").slice(0, 4000),
    productAnalysis: String(record.productAnalysis || "").slice(0, 8000),
    referenceAnalysis: String(record.referenceAnalysis || "").slice(0, 8000),
    useReferenceAnalysis: !!record.useReferenceAnalysis,
    persona: String(record.persona || "").slice(0, 200),
    script: String(record.script || "").slice(0, 8000),
    resultUrl: resultUrl.length > MAX_RESULT_URL ? "" : resultUrl
  };
}

module.exports = { Records };
