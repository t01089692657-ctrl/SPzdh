# 依赖说明

平台本身**零第三方代码依赖**：只需要 Node.js 18+，不需要 `npm install`。
其余依赖分两类：**已随包附带的** 和 **需要登录、无法打包的**。

## 一、已随包附带（不用再装）

| 依赖 | 位置 | 用途 |
|---|---|---|
| ffmpeg.exe / ffprobe.exe（Windows 64位） | `deps/bin/win32-x64/` | 智能剪辑：拼接、统一规格、转场 |
| ffmpeg / ffprobe（Linux 64位） | `deps/bin/linux-x64/` | 同上（Linux 服务器用） |

服务器启动时会自动按这个顺序找 ffmpeg：
`config.json 指定路径 → deps/bin/ → OpenMontage 自带 → 系统 PATH`。
什么都不用配，放着就能用。

> 附带的是稳定版静态构建（不支持 xfade 交叉淡化滤镜）。选择“交叉淡入淡出”
> 转场时会自动降级为黑场淡入淡出。如果想要真正的交叉淡化，安装一个
> 新版 ffmpeg（4.3+）到系统 PATH，或运行 `get-ffmpeg` 脚本升级即可，
> 服务器会自动优先用新版。

## 二、需要在服务器上安装/登录的（无法打包进压缩包）

这些依赖绑定账号登录态或者体积/授权原因不能直接分发，**都是可选项**，
缺了哪个就少哪个功能，其余功能不受影响：

| 依赖 | 影响的功能 | 怎么装 |
|---|---|---|
| Node.js 18+ | 整个平台（必装） | <https://nodejs.org/zh-cn> 下载安装 |
| 视觉分析 API Key | “拆解脚本”“分析产品图片” | 在 `config.json` 填 `analysis.apiKey`（sakai.my 或任何 OpenAI 兼容中转） |
| kling CLI（已登录） | 可灵真实生成 | 在服务器安装 kling 命令行并登录快手可灵账号 |
| dreamina CLI（已登录） | 即梦真实生成 | 在服务器安装 dreamina 命令行并登录即梦账号（Windows 下常装在 WSL 里） |
| Codex CLI（已登录） | “交给Codex”自动分析 | `npm install -g @openai/codex` 后 `codex login` |
| OpenMontage | 可选剪辑增强 | 不装也行，剪辑走内置 ffmpeg 引擎 |

装好后打开 **管理后台 → 依赖与引擎状态 → 重新检测**，全绿即可。

## 三、自检与补装脚本

| 脚本 | 系统 | 作用 |
|---|---|---|
| `check-deps.bat` | Windows | 一键检测所有依赖状态 |
| `check-deps.sh` | Linux/macOS | 同上 |
| `get-ffmpeg.bat` | Windows | ffmpeg 丢失/损坏时重新下载到 deps/bin |
| `get-ffmpeg.sh` | Linux/macOS | 优先走系统包管理器装新版 ffmpeg，失败则下载静态版 |
