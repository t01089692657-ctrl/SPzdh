const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, randomId, sendJson } = require("./utils");
const { httpError } = require("./auth");

// 生成/剪辑/Codex 都是分钟级长任务，HTTP 长连接容易超时断开，
// 所以统一走异步任务：提交返回 jobId，前端轮询状态。
// 每类任务一条串行队列，避免多员工同时打爆生成额度或 CPU。
const LANES = {
  kling: 1,
  jimeng: 1,
  edit: 1,
  codex: 2
};

class Jobs {
  constructor(config) {
    this.config = config;
    this.runners = new Map();
    this.jobs = new Map();
    this.queues = new Map();
    this.active = new Map();
    ensureDir(config.jobDir);
    this.loadPersisted();
  }

  register(type, lane, runner) {
    this.runners.set(type, { lane, runner });
  }

  loadPersisted() {
    let files = [];
    try {
      files = fs.readdirSync(this.config.jobDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const loaded = [];
    for (const name of files) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.config.jobDir, name), "utf8"));
        if (["queued", "running"].includes(job.status)) {
          job.status = "interrupted";
          job.error = "服务重启，任务中断，请重新提交。";
          job.finishedAt = job.finishedAt || nowIso();
          this.persist(job);
        }
        loaded.push(job);
      } catch {
        // 跳过损坏的任务文件
      }
    }
    loaded.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const job of loaded.slice(-this.config.limits.jobHistory)) {
      this.jobs.set(job.id, job);
    }
  }

  persist(job) {
    const { payload, ...persistable } = job;
    try {
      fs.writeFileSync(path.join(this.config.jobDir, `${job.id}.json`), JSON.stringify(persistable, null, 2), "utf8");
    } catch (error) {
      console.warn(`[jobs] 任务持久化失败：${error.message}`);
    }
  }

  create(type, owner, payload, meta = {}) {
    const entry = this.runners.get(type);
    if (!entry) throw httpError(400, `任务类型无效：${type}`);
    const job = {
      id: randomId(`${type}_`),
      type,
      lane: entry.lane,
      owner,
      status: "queued",
      progress: { stage: "排队中", percent: 0 },
      meta,
      payload,
      result: null,
      error: "",
      createdAt: nowIso(),
      startedAt: "",
      finishedAt: ""
    };
    this.jobs.set(job.id, job);
    this.trim();
    this.persist(job);
    this.enqueue(job);
    return this.publicJob(job);
  }

  enqueue(job) {
    const queue = this.queues.get(job.lane) || [];
    queue.push(job.id);
    this.queues.set(job.lane, queue);
    this.pump(job.lane);
  }

  pump(lane) {
    const limit = LANES[lane] || 1;
    const running = this.active.get(lane) || 0;
    if (running >= limit) return;
    const queue = this.queues.get(lane) || [];
    const nextId = queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job || job.status !== "queued") {
      this.pump(lane);
      return;
    }
    this.active.set(lane, running + 1);
    this.run(job).finally(() => {
      this.active.set(lane, (this.active.get(lane) || 1) - 1);
      this.pump(lane);
    });
  }

  async run(job) {
    const entry = this.runners.get(job.type);
    job.status = "running";
    job.startedAt = nowIso();
    job.progress = { stage: "正在执行", percent: 5 };
    this.persist(job);
    const setProgress = (stage, percent) => {
      job.progress = { stage: String(stage), percent: Math.max(0, Math.min(99, Math.round(percent))) };
    };
    try {
      const result = await entry.runner(job, { setProgress });
      job.status = "done";
      job.result = result;
      job.progress = { stage: "完成", percent: 100 };
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "任务执行失败。";
      job.progress = { stage: "失败", percent: 100 };
    } finally {
      job.payload = null;
      job.finishedAt = nowIso();
      this.persist(job);
    }
  }

  trim() {
    const excess = this.jobs.size - this.config.limits.jobHistory;
    if (excess <= 0) return;
    const finished = [...this.jobs.values()]
      .filter((job) => !["queued", "running"].includes(job.status))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const job of finished.slice(0, excess)) {
      this.jobs.delete(job.id);
      try {
        fs.unlinkSync(path.join(this.config.jobDir, `${job.id}.json`));
      } catch {
        // 忽略
      }
    }
  }

  get(id, requester) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, "任务不存在或已被清理。");
    if (requester.role !== "admin" && job.owner !== requester.username) {
      throw httpError(403, "无权查看该任务。");
    }
    return this.publicJob(job);
  }

  list(requester, { all = false } = {}) {
    const jobs = [...this.jobs.values()]
      .filter((job) => (all && requester.role === "admin") || job.owner === requester.username)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 50)
      .map((job) => this.publicJob(job, { brief: true }));
    return jobs;
  }

  queueSummary() {
    const summary = {};
    for (const lane of Object.keys(LANES)) {
      summary[lane] = {
        running: this.active.get(lane) || 0,
        queued: (this.queues.get(lane) || []).length
      };
    }
    return summary;
  }

  publicJob(job, { brief = false } = {}) {
    const base = {
      id: job.id,
      type: job.type,
      owner: job.owner,
      status: job.status,
      progress: job.progress,
      meta: job.meta,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
    if (!brief) base.result = job.result;
    return base;
  }
}

module.exports = { Jobs, LANES, sendJson };
