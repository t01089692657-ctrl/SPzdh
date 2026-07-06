# AI 视频创作平台（公司内部多人版）

在原“AI 视频创作助手”（单机版）基础上升级成的小平台：部署在一台电脑/迷你主机上，
公司员工在自己电脑、手机的浏览器里打开局域网地址即可登录使用。

## 功能

- **参考视频拆解**：上传参考视频/长图，自动抽关键帧，AI 拆解脚本结构
- **产品分析**：上传产品图，AI 输出卖点/镜头建议/产品描述
- **Codex 自动分析**：服务器装有 Codex CLI 时，可交给 Codex 深度分析
- **AI 视频生成**：可灵（快手）/ 即梦（字节）真实生成，本地模拟不耗额度
- **智能剪辑**：多段素材拼接、统一 9:16/16:9/1:1 规格、加转场 —— 内置 ffmpeg 引擎，**开箱即用**
- **多人使用**：账号登录、每人独立的历史记录和项目、任务排队互不干扰
- **管理后台**：依赖状态一屏看清、开号/停用/重置密码、全员任务监控

## 五分钟部署（Windows 迷你主机）

1. 解压这个压缩包到任意目录（例如 `D:\AI视频创作平台`）
2. 安装 [Node.js 18+](https://nodejs.org/zh-cn)（如果还没装）
3. 双击 **`启动平台.bat`**
4. 窗口里会显示局域网地址，例如 `http://192.168.1.50:8781/`，把它发给同事
5. 用初始管理员账号登录：**admin / admin123**，进入右上角 **管理后台**：
   - **立即修改管理员密码**
   - 给员工逐个开账号（或在 config.json 设置邀请码让员工自助注册）
   - 查看“依赖与引擎状态”，需要哪个功能就补哪个依赖

> Linux 迷你主机：安装 Node.js 后执行 `./start.sh`。建议再配 systemd 或 pm2 开机自启。

## 依赖情况（详见 `deps/README.md`）

**已随包附带、不用装**：ffmpeg/ffprobe（Windows + Linux 静态版，智能剪辑开箱即用）；
平台代码零第三方依赖，不需要 `npm install`。

**装了才有对应功能（都是可选）**：

| 想要的功能 | 需要在服务器上准备 |
|---|---|
| 拆解脚本 / 分析产品图片 | 视觉分析 API Key（填进 config.json） |
| 可灵真实生成 | kling CLI 已安装并登录 |
| 即梦真实生成 | dreamina CLI 已安装并登录 |
| 交给Codex | Codex CLI 已安装并登录 |
| OpenMontage 剪辑增强 | 安装 OpenMontage（不装则用内置引擎，效果相近） |

自检：双击 `deps/check-deps.bat`（Linux 用 `deps/check-deps.sh`），
或启动后到 **管理后台 → 依赖与引擎状态**。

## 配置（可选）

首次需要配置时，把 `config.example.json` 复制为 `config.json` 再改：

```jsonc
{
  "host": "0.0.0.0",          // 0.0.0.0=局域网可访问；127.0.0.1=只许本机
  "port": 8781,
  "analysis": {
    "apiKey": "你的APIKey",    // 视觉分析（sakai.my 或任何 OpenAI 兼容中转）
    "baseUrl": "https://sakai.my",
    "model": "gpt-5.5"
  },
  "registration": { "inviteCode": "" },  // 填了员工就能凭邀请码自助注册
  "openMontageRoot": ""       // 装了 OpenMontage 才填
}
```

旧版的环境变量 `SAKAI_API_KEY` / `SAKAI_BASE_URL` / `SAKAI_MODEL` / `OPENMONTAGE_ROOT`
仍然有效，优先级高于 config.json。

## 数据存放

所有数据都在 `data/` 目录（自动创建）：

```
data/
├── users.json       账号（密码已加密存储）
├── sessions.json    登录会话
├── records/         每个员工的历史记录和项目
├── jobs/            任务记录
├── uploads/         上传的素材
├── outputs/         剪辑/生成的成品视频
└── codex-jobs/      Codex 分析任务
```

**备份就是拷走 `data/` 文件夹**；迁移新机器 = 拷贝整个平台目录 + data。

## 安全说明

- 密码用 scrypt 加盐哈希存储；登录有失败次数限制（10 次/10 分钟）
- 所有业务接口都要求登录；成品视频 `/outputs/` 也需要登录才能访问
- 平台设计为**公司局域网内使用**。如需公网访问，请套一层 HTTPS 反向代理
  （如 nginx + 证书），不要把端口直接暴露到公网
- API Key 只存在服务器的 config.json / 环境变量里，不会下发给浏览器

## 与旧版的区别

| | 旧版（单机） | 新版（平台） |
|---|---|---|
| 使用范围 | 只能本机 127.0.0.1 | 局域网多人，账号登录 |
| 历史/项目 | 存浏览器 localStorage | 存服务器，换电脑不丢 |
| 剪辑 | 必须装 OpenMontage | 内置 ffmpeg 引擎开箱即用，OpenMontage 变为可选 |
| 生成/剪辑执行 | HTTP 长连接容易超时 | 异步任务队列 + 进度轮询，多人排队不打架 |
| ffmpeg | 依赖 OpenMontage 自带 | 随包附带 Windows/Linux 双版本 |
| 系统 | 仅 Windows | Windows / Linux / macOS |
| 管理 | 无 | 管理后台：用户、依赖状态、任务监控 |
