# dsh-api-balance

在 DeepSeek Harness（DSH）的 Web 界面会话头部常驻一个 **API 余额徽标**：显示 DeepSeek 账户剩余金额，点击展开面板可查看**本会话的 token 用量与估算费用**（含缓存命中率、按模型的费用明细）。插件随 Harness 启动自动加载，进程重启不丢失。

- 宿主端：`getBalance` 通过凭据服务读取 `DEEPSEEK_API_KEY`，经 curl 调用 DeepSeek 余额接口（Key 只放在环境变量里，绝不进入命令行）；`getSessionUsage` 回放会话日志，按模型归集 Provider 上报的 token 用量，并按价目表估算费用。
- 前端端：徽标注册进 `conversation.session.header.utilities` 插槽（追加式，不替换任何现有 UI），token 数读取持久的 `tokenUsage` 会话投影。

```
┌──────────────────────────────────────┐
│ 会话头部: [● CNY 110.00]   ← 徽标    │
│                                      │
│ 点击展开面板:                         │
│   API 概览                    [可用]  │
│   账户余额                            │
│   CNY                                 │
│   剩余金额    110.00                  │
│   ─────────────────────────────       │
│   本会话用量                          │
│   Tokens · 输入 4.6M · 输出 64.7K  缓存 98% │
│   估算费用     ¥0.653                 │
│   按官方实时价目估算（峰谷分时），实际以账单为准 │
│   更新于 21:05:12            [刷新]   │
└──────────────────────────────────────┘
```

## 特性

- ✅ 会话头部常驻余额徽标（多币种），可用状态圆点（绿=可用 / 黄=不可用 / 红=错误）
- ✅ 面板显示「剩余金额」与「本会话用量」：输入/输出 tokens、缓存命中率、估算费用
- ✅ 多模型会话按模型分开展示费用；未收录价目的模型标注「部分未收录」
- ✅ **价目自动更新**：运行时抓取 DeepSeek 官方价格页解析（缓存 6 小时），失败回退内置表
- ✅ 持久化插件：注册进 web bundle，每次启动自动加载；另有免构建的动态插件版（见下文）
- ✅ 深色/浅色主题自适应（使用 `--dsw-alias-*` 主题 token）

## 目录结构

```
dsh-api-balance/
├── plugin-host/      # 宿主插件 @deepseek-ai/dsh-api-balance（Remote 服务）
├── plugin-client/    # 前端插件 @deepseek-ai/dsh-client-ui-api-balance（徽标 UI）
├── dynamic/          # 免构建的动态插件版（粘贴进 cordis_define 即可用）
├── scripts/
│   └── install.sh    # 一键安装到 deepseek-harness 检出（持久化版）
├── docs/
│   └── architecture.md   # 实现说明（含价目自动更新机制）
├── README.md         # 本文档（中文）
└── README.en.md      # English
```

## 两种安装方式

### 方式 A：一键安装为持久化插件（推荐，重启不丢失）

前提：本机有 **deepseek-harness 的 git 检出**（能跑 `pnpm install` / `pnpm run build` 的环境），并已配置 `DEEPSEEK_API_KEY`。

```bash
# 1. 下载本项目并进入目录
git clone <你的仓库地址> && cd dsh-api-balance

# 2. 一键安装（HARNESS_DIR 指向你的 deepseek-harness 检出根目录）
bash scripts/install.sh /path/to/deepseek-harness

# 3. 在检出目录里安装依赖并构建
cd /path/to/deepseek-harness
pnpm install
pnpm run build:lib

# 4. 重启 dsh web，会话头部即可看到余额徽标
```

> `install.sh` 是幂等的：重复执行不会重复打补丁。它只做复制与注册（宿主行、前端 roster、`remote.apiBalance` 汇总、tsconfig 引用/路径），不修改你的业务配置。

### 方式 B：动态插件（免构建，5 秒上手，但进程重启后消失）

适合先体验，或在无法构建的环境里使用。在 DSH 会话中让模型执行：

1. 用 `cordis_define` 创建插件，`code.host` 粘贴 `dynamic/plugin.host.js` 的内容，`code.client` 粘贴 `dynamic/plugin.client.js` 的内容（保留函数体本身）；
2. 用 `cordis_run` 运行它；
3. 会话头部即出现徽标。注意：动态插件只存在于当前进程，**重启后需要重新创建**。

## 配置

插件通过 Harness 的凭据服务读取 `DEEPSEEK_API_KEY`（优先进程环境变量，其次 `~/.dsh/.env` 或项目 `.env`，最后凭据仓库）。未配置时徽标会显示「余额不可用」并给出提示。

## 费用估算与自动更新

- **价目自动更新（无需手动同步）**：`getSessionUsage` 会抓取 DeepSeek 官方价格页
  `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` 并解析价格表，缓存 6 小时；
  DeepSeek 官方调价后最多 6 小时自动生效。页面不可达或结构变化时回退内置
  `FALLBACK_RATES` 表（`plugin-host/src/index.ts`），面板会标注本次用的是实时价目还是回退价目。
- 峰谷：北京时间 09:00-12:00、14:00-18:00 用高峰档（页面给出的高峰价），其余用闲时档。
  时段规则写在 `isBeijingPeak`（官方页面不公布时段），若 DeepSeek 调整时段仍需改这一处。
- cache-write 按输入未命中价计。
- 金额为展示用**估算**，实际以 DeepSeek 账单为准。

## 测试

```bash
# 在 deepseek-harness 检出内（安装方式 A 之后）
pnpm exec vitest run packages/host/api-balance packages/client/ui-api-balance
```

## License

MIT，见 [LICENSE](LICENSE)。
