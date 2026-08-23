# 动态插件版（免构建，进程级）

这是免构建的动态插件版本：把 `plugin.host.js` / `plugin.client.js` 的内容粘贴进 DSH 的
`cordis_define` 即可使用，适合快速体验或在无法构建 deepseek-harness 的环境中使用。

## 使用步骤

1. 在 DSH 会话中让模型执行 `cordis_define`，创建插件：
   - `code.host`：粘贴 `plugin.host.js` 的全部内容（以 `return { ... }` 开头的函数体）；
   - `code.client`：粘贴 `plugin.client.js` 的全部内容。
2. 用 `cordis_run` 运行该插件（可能需要你在界面批准）。
3. 会话头部即出现余额徽标，点击展开面板查看本会话用量与估算费用。

## 注意

- **进程级**：动态插件只存在于当前进程，Harness 重启后定义即丢失，需要重新创建。
- 需要已配置 `DEEPSEEK_API_KEY`（进程环境变量 / `~/.dsh/.env` / 项目 `.env` / 凭据仓库）。
- **价目自动更新**：运行时抓取官方价格页（每 6 小时刷新一次缓存），解析失败时回退
  `plugin.host.js` 内置的 `FALLBACK_RATES` 表；面板会标注「按官方实时价目估算」或
  「按内置价目估算（官方价目获取失败）」。DeepSeek 官方调价后无需手动同步。
- 唯一仍需代码维护的是**峰谷时段**（北京 09:00-12:00、14:00-18:00，写死在
  `isPeak` 里；官方页面不公布时段）。

想要「重启不丢失」的体验，请使用持久化版：`bash scripts/install.sh <deepseek-harness目录>`。
