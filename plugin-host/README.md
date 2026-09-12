# @deepseek-ai/dsh-api-balance

DeepSeek API balance and per-session usage/cost Remote gateway. The Web surface
consumes it through the generated `remote.apiBalance` namespace.

## Model Experience

No model-facing behavior. The gateway never prompts a model: `getBalance` calls
the DeepSeek balance endpoint through the shell provider and `getSessionUsage`
replays a session's durable log. It adds no tokens to any model request and
holds no KV-cache state.

## Usage

The service reads `credentials` (DEEPSEEK_API_KEY), `shell` (curl),
`sessionQuery` (durable log replay), and optionally `web` (pricing page fetch)
per call, so it mounts wherever those services exist:

```yaml
- id: api-balance
  name: '@deepseek-ai/dsh-api-balance'
```

`getBalance()` returns normalized `balance_infos` entries; `getSessionUsage(sessionId)`
returns per-model token buckets plus an estimated cost in CNY.

## Cost estimation

`getSessionUsage` folds provider-reported usage (`assistant/message` and
`assistant/chunk` usage samples) per model and prices it under the DeepSeek V4
rate card, in CNY per 1M tokens, with Beijing peak windows (09:00-12:00,
14:00-18:00) billed at the peak rate.

The rate card is **resolved at runtime**: the gateway fetches the official
pricing page (`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`)
through the `web` provider and parses the price table, caching it for 6 hours.

- **Model names come from the page**, not from code, so a newly published model
  generation is priced as soon as the page lists it. Each header cell drops its
  `<sup>` footnote marker (`deepseek-flash<sup>(1)</sup>` is the model id
  `deepseek-flash`), and a trailing `(1)`-style reference is stripped too.
- The live card is **overlaid on** the baked `FALLBACK_RATES` table rather than
  replacing it: the page lists only the models it currently markets, while the
  fallback still carries superseded ids that older session logs recorded.
- When the page is unreachable or unparsable the baked table alone prices the
  session.

The result reports `ratesSource: 'live' | 'fallback'` so the UI can say which
card priced the session.

Cache-write tokens are billed at the input-miss rate. Models without a rate-card
entry report tokens with `priced: false` and zero cost.

## Known Limitations and Deferred Work

- The peak/off-peak **schedule** (09:00-12:00 and 14:00-18:00 Beijing) is baked
  into `isBeijingPeak`; the official page does not state the hours, so a
  schedule change still needs a code update. The prices and model list
  auto-update.
- Session-side lookup is an exact model-id match. The page's current ids work
  live; a superseded id prices only while it stays in `FALLBACK_RATES`, and
  removing it from that table makes historical sessions report `priced: false`.
- The live price parser targets the current Docusaurus table structure
  (Chinese labels 缓存命中 / 缓存未命中 / 输出 with 空闲时段 / 高峰时段 rows);
  a restructured page falls back to the baked table.
- A usage chunk whose step never settles into an `assistant/message` is
  attributed to the `unknown` model and therefore unpriced.
- Cost is an estimate for display: actual billing is the DeepSeek invoice.
