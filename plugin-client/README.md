# @deepseek-ai/dsh-client-ui-api-balance

Persistent Session Header utility showing the DeepSeek API account balance as a
compact capsule, expandable into an overview panel with the account balance and
the current session's token usage and estimated cost. The data comes from the
`remote.apiBalance` generated Remote namespace backed by
`@deepseek-ai/dsh-api-balance`.

## Model Experience

No model-facing behavior. The badge renders a Remote result and the durable
`tokenUsage` session projection; it adds no tokens to any model request and
holds no KV-cache state. The panel reloads the balance on mount and refreshes
both sections on the 刷新 button; the usage cost is recomputed per panel open.

## Known Limitations and Deferred Work

- The badge loads the balance once on mount; there is no background polling, so
  the figure can go stale while a long conversation spends tokens. Click 刷新
  to refresh, or reopen the panel.
- The cost figure is an estimate produced by the host rate card and can lag a
  still-streaming turn because it reads the durable log.
- The dropdown panel is positioned under the badge inside the Session Header;
  a header with tight overflow constraints could clip it.
