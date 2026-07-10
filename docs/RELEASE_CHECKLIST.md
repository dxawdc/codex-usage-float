# 安全发布与 GitHub Release 检查清单

## 发布前

- [ ] `package.json`、`package-lock.json`、更新记录和产物文件名使用同一个新版本号。
- [ ] `git status --short` 仅包含计划发布的源码、测试和文档。
- [ ] 搜索并确认不存在 token、`auth.json`、账号库、Cookie、私钥和抓包正文。
- [ ] 运行 `npm ci` 后执行 `npm run verify`。
- [ ] 执行 `npm run build:dir`，确认 Electron 应用可以完成目录打包。
- [ ] 对目录版或 portable EXE 执行 `--self-test`，确认安全存储和 Codex 只读进程检测通过。
- [ ] 在独立测试账号上验证导入、手动切换、自动切换、添加账号、失效账号提示和删除非当前账号。
- [ ] 确认切换前后项目、任务、会话、插件、配置和日志仍位于同一个 `~/.codex`。
- [ ] 检查 `npm audit --audit-level=high` 为通过状态。

## 产物

- [ ] 执行 `npm run build` 生成 portable EXE。
- [ ] 计算 `Get-FileHash .\dist\CodexUsageFloat-<version>.exe -Algorithm SHA256`。
- [ ] 在干净 Windows 用户环境中启动一次产物，确认首次账号库迁移和 Windows 安全存储可用。
- [ ] 发布说明列出行为变化、迁移方式、已知限制和 SHA-256。
- [ ] Tag、Release 标题、下载链接和 README 校验表版本一致。

## 发布后

- [ ] 从 GitHub Release 重新下载并复核 SHA-256。
- [ ] 验证 latest release 链接和 README 下载链接。
- [ ] 保留前一稳定版本，出现登录或切换回归时停止分发新版本。
