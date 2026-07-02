# Codex Usage Float

一个 Windows 桌面悬浮窗，用来查看 Codex / ChatGPT Codex 的 5 小时、1 周用量窗口、重置卡、会员状态和 Token 使用量。

> 非官方工具。数据来自本机 Codex 登录状态、本地 Codex 会话日志，以及 ChatGPT/Codex 可访问的用量接口。接口字段可能随官方变更而变化。

## 截图

![Overview panel](docs/screenshots/overview-panel.png)

![Compact panel](docs/screenshots/compact-panel.png)

![Reset cards](docs/screenshots/reset-cards.png)

## 功能

- 桌面悬浮球显示当前计划、5 小时窗口剩余百分比。
- 详情面板显示 5 小时和 1 周窗口的剩余量、已用量、重置时间。
- 剩余量用红、橙、黄、绿颜色分级，低剩余额度更醒目。
- 显示当前可用重置卡列表和有效期。
- 显示账号级 Token 使用量：今日、7 天、30 天。
- 自动同步本机 Codex 登录状态，不在日志或状态文件中保存 access token。
- 支持打开 ChatGPT 页面、手动刷新、退出应用。
- 可打包为 Windows portable EXE。

## 数据来源

应用优先读取 `~/.codex/auth.json` 中的 Codex 登录信息，用于请求 ChatGPT/Codex 用量数据。Token 使用量优先使用账号接口返回的统计桶；如果账号接口不可用，则回退到本地 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 中的 `token_count` 事件做估算。

本地 session 日志中通常包含输入、缓存输入、输出、推理输出等明细字段，但历史数据在切换账号后可能无法 100% 精确归属账号。账号接口通常只返回总 Token 数，不一定包含输入/输出/缓存拆分。

## 隐私

- 不打印、不持久化 access token。
- 状态文件位于 `%APPDATA%/codex-usage-float/usage-state.json`。
- 截图仅用于展示 UI，请不要提交包含个人资料或对话内容的截图。

## 开发

需要 Node.js 和 npm。

```powershell
npm install
npm start
```

常用脚本：

```powershell
npm run dev
npm run build
npm run build:dir
```

## 打包

默认打包为 Windows portable EXE：

```powershell
npm run build
```

构建产物输出到 `dist/`。该目录不提交到 Git。

如果 Electron 下载较慢，可以在 PowerShell 中设置镜像后再打包：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build
```

## 项目结构

```text
src/main.js              Electron 主进程、数据同步、窗口管理
src/preload.js           安全 IPC 桥接
src/renderer/            悬浮窗和详情面板 UI
build/                   应用图标
docs/screenshots/        README 示例截图
```

## 说明

这个项目主要面向个人桌面使用场景，适合想快速了解 Codex 当前剩余额度、重置时间和最近 Token 用量的人。由于 Codex 相关接口和本地日志结构仍可能变化，建议把结果作为用量参考，而不是账单级审计数据。
