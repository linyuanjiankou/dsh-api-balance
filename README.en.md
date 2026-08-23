# dsh-api-balance

A persistent **API balance badge** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web UI. It lives in the session header, shows your DeepSeek account balance, and expands into a panel with the **current session's token usage and estimated cost** (input/output tokens, cache-hit rate, per-model cost breakdown). It loads automatically at every Harness start and survives process restarts.

- Host side: `getBalance` resolves `DEEPSEEK_API_KEY` through the credential seam and calls the DeepSeek balance endpoint via curl (the key rides an explicit env entry, never the command line); `getSessionUsage` replays the durable session log and folds provider-reported usage per model, priced under the live official rate card.
- Client side: the badge registers into the `conversation.session.header.utilities` slot (additive; nothing is replaced), and token counts come from the durable `tokenUsage` session projection.

## Features

- Persistent session-header balance badge (multi-currency) with a status dot (green = available / yellow = unavailable / red = error)
- Panel shows the remaining balance plus per-session usage: input/output tokens, cache-hit rate, estimated cost
- Multi-model sessions break cost down per model; models without a rate-card entry are flagged as unpriced
- **Auto-updating prices**: the host fetches the official DeepSeek pricing page at runtime (6h cache) and falls back to a baked table when the page is unreachable
- Auto-loads at boot as a bundle-registered plugin; a build-free dynamic-plugin variant is also included (see below)
- Light/dark theme aware (`--dsw-alias-*` theme tokens)

## Layout

```
dsh-api-balance/
├── plugin-host/      # Host plugin @deepseek-ai/dsh-api-balance (Remote service)
├── plugin-client/    # Browser plugin @deepseek-ai/dsh-client-ui-api-balance (badge UI)
├── dynamic/          # Build-free dynamic-plugin variant (paste into cordis_define)
├── scripts/
│   └── install.sh    # One-shot installer into a deepseek-harness checkout
├── docs/
│   └── architecture.md
├── README.md         # Chinese
└── README.en.md      # This file
```

## Installation

### Option A: one-shot persistent install (recommended, survives restarts)

Prerequisites: a **git checkout of deepseek-harness** with a working `pnpm install` / `pnpm run build`, and a configured `DEEPSEEK_API_KEY`.

```bash
git clone <your-repo-url> && cd dsh-api-balance
bash scripts/install.sh /path/to/deepseek-harness   # idempotent
cd /path/to/deepseek-harness
pnpm install
pnpm run build:lib
# restart `dsh web` — the badge appears in the session header
```

`install.sh` is idempotent: re-running it never double-patches. It only copies the two packages and applies the registration edits (host row, `dsh.client` roster, `remote.apiBalance` assembly, tsconfig references/paths); it never touches your business configuration.

### Option B: dynamic plugin (build-free, but process-local)

For a quick try or a build-less environment: ask a DSH agent to create a plugin with `cordis_define` — paste `dynamic/plugin.host.js` into `code.host` and `dynamic/plugin.client.js` into `code.client` — then `cordis_run` it. The badge appears immediately, but dynamic plugins are process-local and vanish on restart.

## Configuration

The plugin resolves `DEEPSEEK_API_KEY` through the Harness credential seam (process env first, then `~/.dsh/.env` or the project `.env`, then the credential store). Without a key the badge shows "余额不可用" with a hint.

## Cost estimation and auto-updating prices

- **No manual sync**: `getSessionUsage` fetches the official pricing page (`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`) and parses the price table, caching it for 6 hours, so official price changes apply automatically within 6 hours. When the page is unreachable or restructured it falls back to the baked `FALLBACK_RATES` table in `plugin-host/src/index.ts`; the panel notes which card priced the session.
- Peak hours: 09:00-12:00 and 14:00-18:00 Beijing time use the peak tier from the page, the rest the off-peak tier. The schedule itself lives in `isBeijingPeak` (the official page does not publish the hours).
- Cache-write tokens bill at the input-miss rate.
- The amount is an **estimate for display**; the DeepSeek invoice is authoritative.

## Tests

```bash
# inside the deepseek-harness checkout (after Option A)
pnpm exec vitest run packages/host/api-balance packages/client/ui-api-balance
```

## License

MIT — see [LICENSE](LICENSE).
