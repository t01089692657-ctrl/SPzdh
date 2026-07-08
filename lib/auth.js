const crypto = require("crypto");
const path = require("path");
const { JsonStore } = require("./store");
const { nowIso } = require("./utils");

const USERNAME_RE = /^[a-zA-Z0-9_一-龥.-]{2,32}$/;

class Auth {
  constructor(config) {
    this.config = config;
    this.userStore = new JsonStore(path.join(config.dataDir, "users.json"), { users: [] });
    this.sessionStore = new JsonStore(path.join(config.dataDir, "sessions.json"), { sessions: {} });
    this.loginFailures = new Map(); // ip -> {count, firstAt}
    this.bootstrapAdmin();
    this.pruneSessions();
    // 运行期间定期清理过期会话，避免 sessions.json 无限增长（每请求都要全量读取该文件）
    this.pruneTimer = setInterval(() => this.pruneSessions(), 30 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  bootstrapAdmin() {
    const data = this.userStore.read();
    if (data.users.length) return;
    // 随机初始密码：不再硬编码 admin123，避免公司里人人皆知的默认口令。首启时打印到服务器控制台。
    const password = crypto.randomBytes(6).toString("base64").replace(/[+/=]/g, "").slice(0, 10) || "admin123";
    data.users.push(this.buildUser("admin", password, { displayName: "管理员", role: "admin" }));
    this.userStore.write(data);
    console.log("======================================");
    console.log("[auth] 已创建初始管理员账号：");
    console.log(`         用户名: admin`);
    console.log(`         密码:   ${password}`);
    console.log("       请登录后立即在“管理后台”修改密码！此密码只在这里显示一次。");
    console.log("======================================");
    // 同时落一个一次性文件，方便管理员回看（登录改密后可删除）
    try {
      require("fs").writeFileSync(
        path.join(this.config.dataDir, "初始管理员密码.txt"),
        `用户名: admin\n密码: ${password}\n\n请登录后立即修改密码，然后删除本文件。\n`,
        "utf8"
      );
    } catch {
      // 忽略
    }
  }

  buildUser(username, password, { displayName = "", role = "member" } = {}) {
    const salt = crypto.randomBytes(16).toString("hex");
    return {
      username,
      displayName: displayName || username,
      role,
      salt,
      passwordHash: hashPassword(password, salt),
      disabled: false,
      createdAt: nowIso()
    };
  }

  findUser(username) {
    return this.userStore.read().users.find((user) => user.username === username) || null;
  }

  listUsers() {
    return this.userStore.read().users.map(publicUser);
  }

  createUser({ username, password, displayName, role }) {
    username = String(username || "").trim();
    if (!USERNAME_RE.test(username)) throw httpError(400, "用户名需为 2-32 位字母/数字/中文/._-。");
    if (String(password || "").length < 6) throw httpError(400, "密码至少 6 位。");
    const roleValue = role === "admin" ? "admin" : "member";
    let created;
    this.userStore.update((data) => {
      if (data.users.some((user) => user.username === username)) throw httpError(409, "用户名已存在。");
      created = this.buildUser(username, password, { displayName, role: roleValue });
      data.users.push(created);
    });
    return publicUser(created);
  }

  setPassword(username, password) {
    if (String(password || "").length < 6) throw httpError(400, "密码至少 6 位。");
    this.userStore.update((data) => {
      const user = data.users.find((item) => item.username === username);
      if (!user) throw httpError(404, "用户不存在。");
      user.salt = crypto.randomBytes(16).toString("hex");
      user.passwordHash = hashPassword(password, user.salt);
      user.updatedAt = nowIso();
    });
    this.revokeUserSessions(username);
  }

  setDisabled(username, disabled) {
    this.userStore.update((data) => {
      const user = data.users.find((item) => item.username === username);
      if (!user) throw httpError(404, "用户不存在。");
      if (user.role === "admin" && disabled && this.countActiveAdmins(data) <= 1) {
        throw httpError(400, "不能停用最后一个管理员。");
      }
      user.disabled = !!disabled;
      user.updatedAt = nowIso();
    });
    if (disabled) this.revokeUserSessions(username);
  }

  deleteUser(username, actor) {
    if (username === actor) throw httpError(400, "不能删除自己。");
    this.userStore.update((data) => {
      const user = data.users.find((item) => item.username === username);
      if (!user) throw httpError(404, "用户不存在。");
      if (user.role === "admin" && this.countActiveAdmins(data) <= 1) {
        throw httpError(400, "不能删除最后一个管理员。");
      }
      data.users = data.users.filter((item) => item.username !== username);
    });
    this.revokeUserSessions(username);
  }

  countActiveAdmins(data) {
    return data.users.filter((user) => user.role === "admin" && !user.disabled).length;
  }

  checkLoginRateLimit(ip) {
    const entry = this.loginFailures.get(ip);
    if (!entry) return;
    if (Date.now() - entry.firstAt > 10 * 60 * 1000) {
      this.loginFailures.delete(ip);
      return;
    }
    if (entry.count >= 10) throw httpError(429, "登录失败次数过多，请 10 分钟后再试。");
  }

  recordLoginFailure(ip) {
    const entry = this.loginFailures.get(ip) || { count: 0, firstAt: Date.now() };
    entry.count += 1;
    this.loginFailures.set(ip, entry);
  }

  login(username, password, ip) {
    this.checkLoginRateLimit(ip);
    const user = this.findUser(String(username || "").trim());
    const ok = user && !user.disabled && verifyPassword(password, user.salt, user.passwordHash);
    if (!ok) {
      this.recordLoginFailure(ip);
      throw httpError(401, "用户名或密码不正确。");
    }
    this.loginFailures.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    this.sessionStore.update((data) => {
      data.sessions[token] = {
        username: user.username,
        createdAt: nowIso(),
        expiresAt: Date.now() + this.config.session.ttlHours * 3600 * 1000
      };
    });
    return { token, user: publicUser(user) };
  }

  // 只校验用户名+密码是否匹配，不发会话、不计入登录失败限流。
  // 用于“已登录用户改密”验证旧密码——输错不应把该 IP 锁在登录门外。
  verifyCredential(username, password) {
    const user = this.findUser(String(username || "").trim());
    return !!(user && !user.disabled && verifyPassword(password, user.salt, user.passwordHash));
  }

  logout(token) {
    if (!token) return;
    this.sessionStore.update((data) => {
      delete data.sessions[token];
    });
  }

  revokeUserSessions(username) {
    this.sessionStore.update((data) => {
      for (const [token, session] of Object.entries(data.sessions)) {
        if (session.username === username) delete data.sessions[token];
      }
    });
  }

  pruneSessions() {
    this.sessionStore.update((data) => {
      for (const [token, session] of Object.entries(data.sessions)) {
        if (!session.expiresAt || session.expiresAt < Date.now()) delete data.sessions[token];
      }
    });
  }

  sessionUser(req) {
    const token = parseCookies(req).sid;
    if (!token) return null;
    const session = this.sessionStore.read().sessions[token];
    if (!session || session.expiresAt < Date.now()) return null;
    const user = this.findUser(session.username);
    if (!user || user.disabled) return null;
    return { ...publicUser(user), token };
  }

  register({ username, password, displayName, inviteCode }) {
    const expected = this.config.registration.inviteCode;
    if (!expected) throw httpError(403, "管理员未开启自助注册，请联系管理员开通账号。");
    if (String(inviteCode || "") !== expected) throw httpError(403, "邀请码不正确。");
    return this.createUser({ username, password, displayName, role: "member" });
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    disabled: !!user.disabled,
    createdAt: user.createdAt
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    // 同主机其他应用可能写入畸形编码的 cookie；decode 失败时退回原始值而非抛 URIError 崩掉整个请求
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { Auth, parseCookies, httpError };
