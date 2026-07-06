const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./utils");

// 简单 JSON 文件存储：原子写入（先写临时文件再改名），进程内串行化。
class JsonStore {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
    ensureDir(path.dirname(filePath));
  }

  read() {
    if (!fs.existsSync(this.filePath)) return structuredClone(this.fallback);
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^﻿/, ""));
      return value ?? structuredClone(this.fallback);
    } catch {
      return structuredClone(this.fallback);
    }
  }

  write(value) {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  update(mutator) {
    const value = this.read();
    const next = mutator(value) ?? value;
    this.write(next);
    return next;
  }
}

module.exports = { JsonStore };
