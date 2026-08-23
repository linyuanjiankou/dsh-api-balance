# 实现说明

两个插件包如何协作、如何注册进 DeepSeek Harness，以及价目如何自动更新。

## 架构

```
浏览器 (Web GUI)                    宿主进程 (dsh web)
┌───────────────────┐             ┌───────────────────────────────┐
│ plugin-client      │   Remote    │ plugin-host                   │
│ (ui-api-balance)   │ ──────────► │ (api-balance)                 │
│                    │  RPC 调用   │  ├─ getBalance()             │
│ 徽标 + 面板         │             │  │   credentials.resolve()    │
│  · tokenUsage 投影  │             │  │   shell.run(curl ...)      │
│  · remote.apiBalance│             │  └─ getSessionUsage(sessionId)│
└───────────────────┘             │      sessionQuery.readSession()│
                                  │      → 按模型折叠 token + 计价  │
                                  └───────────────────────────────┘
```

- **plugin-host**（`@deepseek-ai/dsh-api-balance`）：`ApiBalanceGateway` Remote
  服务，通过 typert 生成的 `remote.apiBalance` 命名空间暴露 `getBalance` 与
  `getSessionUsage`。
  - `getBalance`：`credentials.resolve('DEEPSEEK_API_KEY')` 取 Key → 经 `shell`
    执行 curl 调 `https://api.deepseek.com/user/balance`。Key 通过显式 `env`
    条目（`DSH_BALANCE_KEY`）传给 curl，绝不拼进命令行。
  - `getSessionUsage`：`sessionQuery.readSession(sessionId)` 回放持久会话日志，
    从 `assistant/message`（含 `usage` 与 `message.source.model`）与
    `assistant/chunk`（usage 采样）折叠出每模型的 token 桶，并按价目表计价。
    同一 turn/step 的 usage chunk 会被最终的 message 采样替换（不重复计数）。
- **plugin-client**（`@deepseek-ai/dsh-client-ui-api-balance`）：徽标注册进
  `conversation.session.header.utilities` 插槽（追加项，id `api-balance-badge`）。
  - 实时 token 数读 `useProjection('tokenUsage')`（持久投影，压缩/翻页后仍准确）；
  - 余额与费用经注入的回调调用 `remote.apiBalance`；
  - 主题自适应：全部颜色用 `--dsw-alias-*` 语义 token。

## 价目自动更新（无需手动同步）

`getSessionUsage` 不再使用写死的价格表，而是：

1. 通过 `web` 服务抓取官方价格页
   `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`（Docusaurus
   服务端渲染，价格表格在 HTML 中）；
2. 用 `parseRateTable` 解析表格：表头行（`模型`）给出模型名，价格行按
   「缓存命中 / 缓存未命中 / 输出」×「空闲时段 / 高峰时段」填入每档单价；
3. 结果缓存 **6 小时**（`RATES_TTL`），避免每次打开面板都抓页面；
4. 页面不可达、结构变化或解析失败时回退内置 `FALLBACK_RATES` 表。

结果通过 `ratesSource: 'live' | 'fallback'` 告诉前端这次用的是实时价目还是
内置回退价目，面板据此显示「按官方实时价目估算」或「按内置价目估算（官方价目
获取失败）」。DeepSeek 官方调价后，**最多 6 小时自动生效，无需改代码**。

- 桶口径：`uncachedInputTokens`→输入未命中价；`cacheReadTokens`→输入命中价；
  `cacheWriteTokens`→按输入未命中价；`outputTokens`→输出价。
- 峰谷：北京时间 09:00-12:00、14:00-18:00 用 `peak` 档，其余用 `off` 档。
  时段写死在 `isBeijingPeak`（官方页面不公布时段）——价格数字自动更新，
  时段规则如需变动仍需改这一处。
- 模型不在价目表 → `priced: false`、费用 0，前端标注「部分未收录」。
- 金额为展示用估算，实际以 DeepSeek 账单为准。

## 注册面（install.sh 打这些补丁）

1. `packages/api/remotes/src/client/index.ts` — 汇总 `apiBalanceRemote` 与类型导出；
2. `packages/api/remotes/package.json` + `tsconfig.client.json` — 依赖与引用；
3. `packages/bundle/web-app/cordis.patch.yml` — 宿主行 `api-balance` + 前端 roster 行 `ui-api-balance`；
4. `packages/bundle/web-app/package.json` — 两个包的 workspace 依赖；
5. `tsconfig.base.json` / `tsconfig.host.json` / `tsconfig.client.json` — paths 与聚合引用。

构建链：`tsc -b` 生成类型 → tsdown 经 typert 生成器产出 `lib/typert.remote-client.*`（`remote.apiBalance` 的类型与运行时贡献）→ web 端浏览器 roster 按 `dsh.client` 行在运行时加载各包的 `lib/client.js`。
