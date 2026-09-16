# 叠云 Agent（Electron 桌面客户端）

本地 AI Agent 桌面应用：对话、技能、工具调用、定时计划、手机 PWA 连接等。同时保留工位监控上报（CPU / 键鼠统计，Socket.IO）。

npm 包名仍为 `pixel-office-agent`（历史命名）；仓库目录为 **`dieyunagent`**。

## 功能特性

### Agent 核心

- **本地 Gateway** — WebSocket RPC，会话 / 记忆 / 工具 / SQL 只读等
- **技能系统** — 内置与自定义 Skill，向量召回
- **模型配置** — 文本 / 多模态 / Embedding，存 `localStorage`（`diecloud.model.settings.v1`）
- **定时计划** — `plans` 调度（设置 → 自动化）
- **手机连接** — 内网 PWA + Android WebView 壳（`mobile-app/android`）
- **全局用户规则 `dieyun.md`** — `%USERPROFILE%\.dieyun\dieyun.md`，跨项目偏好，自动注入对话与计划

### dieyun.md（全局用户规则）

路径：**`%USERPROFILE%\.dieyun\dieyun.md`**（与 `skills`、`memory` 同级）。写语言、风格、编码习惯等**跨项目**偏好；项目命令与目录请放工作空间 `.dieyun/AGENTS.md`。首次启动若不存在，从 `assets/dieyun.md` 模板生成。设置 → 电脑权限可「在编辑器中打开」。

### 工位监控

- **工位监控**（默认开启）：内网 Socket.IO 实时上报 CPU / 键鼠，默认 `SERVER_URL=http://192.168.31.62:3003/`

## 开发与本地运行

在已安装 [Node.js](https://nodejs.org/) 的前提下：

```bash
cd dieyunagent
npm install
npm start
```

`npm start` 会先执行 `scripts/bootstrap.cjs` 检查依赖。

图标（托盘 + exe + 窗口）：将方形品牌图放到 **`assets/logo-source.png`**（建议 ≥256×256），然后：

```bash
npm run icons
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_URL` | http://192.168.31.62:3003/ | 工位监控 Socket.IO（内网） |
| `COMPUTER_ID` | 主机名推断 DIEYUN{n} 或 `pc-` 前缀 | 电脑唯一 ID |
| `UPDATE_URL` | http://192.168.31.62:3099/ | 自动升级 generic 源（须含 `latest.yml`） |

### 命令行参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--server=URL` | 监控服务器地址 | `--server=http://192.168.1.100:3003` |
| `--id=ID` | 电脑唯一 ID | `--id=pc-office-01` |
| `--hidden` | 隐藏窗口启动 | `--hidden` |

### 打包

```bash
build-installer.bat  # PC + 手机打包，并发布到 Y: 与腾讯 COS
npm run build       # NSIS 安装包（同 build:nsis）
npm run build:nsis  # 仅 NSIS
npm run build:dir   # 解压目录（调试，不生成安装包）
```

典型产物（版本号随 `package.json` 变化）：

- `dist/dieyunagent-Setup-<version>.exe` — NSIS 安装包
- `dist/latest.yml` — 自动更新清单

> Linux 交叉打 NSIS 需 wine32，详见下文「故障排除」。

### 自动升级（generic 静态源）

**完整发版（Windows）**：执行 `build-installer.bat`，输入版本号后会打包 PC 与手机端，并发布到 **`Y:\client-electron\updates-published`** 与腾讯 COS。完整步骤见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。

本机联调：`npm run sync:updates` → `npm run serve:updates`（默认 `:3099`）。

## 开发文档

- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — 发版与 Y: 映射
- **[docs/DESIGN.md](docs/DESIGN.md)** — 架构说明

## 故障排除

### NSIS 在 Linux 上报错 `wow64.dll`

需安装 **wine32**（`dpkg --add-architecture i386` 后安装 `wine wine64 wine32`），或在 **Windows** 上执行 `npm run build:nsis`；Linux 上仅调试可用 `npm run build:dir`。

### 键盘监控不工作

确认系统输入监控权限；检查安全软件是否拦截 `uiohook-napi`。

### 无法连接监控服务器

检查 `SERVER_URL` 与防火墙，确认服务端监听 **3003**。

## 日志

日志由 `electron-log` 写入用户配置目录下的应用数据文件夹。
