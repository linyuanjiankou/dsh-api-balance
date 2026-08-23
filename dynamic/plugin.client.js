// dsh-api-balance — dynamic-plugin Client half
// 用途：在 cordis_define 的 code.client 中粘贴本文件内容（保留 `return { ... }` 函数体本身）。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timer = ctx.get('timer')

    styles.insert(`
      .dsb-wrap{position:relative;display:inline-flex;align-items:center}
      .dsb-badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none;transition:border-color .12s ease}
      .dsb-badge:hover{border-color:var(--dsw-alias-border-l2)}
      .dsb-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none}
      .dsb-ok .dsb-dot{background:var(--dsw-alias-state-success-primary)}
      .dsb-warn .dsb-dot{background:var(--dsw-alias-state-warn-primary)}
      .dsb-err .dsb-dot{background:var(--dsw-alias-state-error-primary)}
      .dsb-label{white-space:nowrap;line-height:1}
      .dsb-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:50;min-width:300px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 10px 28px rgba(0,0,0,.2)}
      .dsb-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}
      .dsb-chip{font-size:11px;padding:1px 8px;border-radius:999px;line-height:1.4}
      .dsb-chip-ok{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary)}
      .dsb-chip-warn{color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}
      .dsb-chip-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}
      .dsb-sec{display:flex;justify-content:space-between;align-items:baseline;margin:8px 0 4px;color:var(--dsw-alias-label-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
      .dsb-currency{display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;font-weight:600}
      .dsb-row{display:flex;justify-content:space-between;padding:2px 0;color:var(--dsw-alias-label-secondary)}
      .dsb-row b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
      .dsb-usage-tokens{display:flex;justify-content:space-between;padding:2px 0;color:var(--dsw-alias-label-secondary)}
      .dsb-usage-tokens b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
      .dsb-cost{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0 2px;font-weight:600}
      .dsb-cost .dsb-amount{font-variant-numeric:tabular-nums}
      .dsb-note{color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 0}
      .dsb-model{display:flex;justify-content:space-between;padding:2px 0;color:var(--dsw-alias-label-secondary);font-size:11px}
      .dsb-model b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
      .dsb-sep{border-top:1px solid var(--dsw-alias-border-l1);margin:6px 0}
      .dsb-foot{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-secondary)}
      .dsb-refresh{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;line-height:1.6}
      .dsb-refresh:hover{border-color:var(--dsw-alias-border-l2)}
      .dsb-err-text{color:var(--dsw-alias-state-error-primary);word-break:break-all;max-width:280px;white-space:pre-wrap}
      .dsb-loading{color:var(--dsw-alias-label-secondary);padding:4px 0}
    `)

    const fmtTokens = (n) => {
      const abs = Math.abs(n)
      if (abs < 1000) return String(n)
      if (abs < 1000000) return (Math.round(n / 100) / 10) + 'K'
      return (Math.round(n / 100000) / 10) + 'M'
    }
    const fmtCost = (c) => (c >= 1 ? '¥' + c.toFixed(2) : '¥' + c.toFixed(4))

    function BalanceBadge(props) {
      const sessionId = props.sessionId
      const useProjection = props.useProjection
      const [view, setView] = React.useState({ status: 'loading', data: null, error: null, updatedAt: null })
      const [usage, setUsage] = React.useState({ status: 'idle', data: null, error: null })
      const [open, setOpen] = React.useState(false)
      const projection = useProjection('tokenUsage')

      const loadBalance = async () => {
        try {
          const res = await host.call('get-balance', {})
          if (res !== null && typeof res === 'object' && res.ok === true) {
            setView({ status: 'ready', data: res.data, error: null, updatedAt: Date.now() })
          } else {
            const msg = (res && typeof res === 'object' && res.error) || '未知错误'
            setView({ status: 'error', data: null, error: String(msg), updatedAt: Date.now() })
          }
        } catch (err) {
          setView({ status: 'error', data: null, error: String((err && err.message) || err), updatedAt: Date.now() })
        }
      }

      const loadUsage = async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setUsage((prev) => prev.status === 'ready' ? prev : { status: 'loading', data: null, error: null })
        try {
          const res = await host.call('get-session-usage', { sessionId })
          if (res !== null && typeof res === 'object' && res.ok === true) {
            setUsage({ status: 'ready', data: res.data, error: null })
          } else {
            const msg = (res && typeof res === 'object' && res.error) || '未知错误'
            setUsage({ status: 'error', data: null, error: String(msg) })
          }
        } catch (err) {
          setUsage({ status: 'error', data: null, error: String((err && err.message) || err) })
        }
      }

      React.useEffect(() => {
        loadBalance()
        if (timer !== undefined) {
          return timer.interval(loadBalance, 120000)
        }
        return undefined
      }, [])

      const toggle = () => {
        const next = !open
        setOpen(next)
        if (next && usage.status === 'idle') loadUsage()
      }
      const refresh = () => {
        loadBalance()
        loadUsage()
      }

      let label = '查询中…'
      let tone = 'neutral'
      let chip = null
      let balanceRows = []
      if (view.status === 'ready' && view.data) {
        const first = view.data.balances[0]
        label = first ? (first.currency + ' ' + first.total) : '余额 0'
        tone = view.data.isAvailable ? 'ok' : 'warn'
        chip = React.createElement('span', { className: 'dsb-chip ' + (view.data.isAvailable ? 'dsb-chip-ok' : 'dsb-chip-warn') },
          view.data.isAvailable ? '可用' : '不可用')
        balanceRows = view.data.balances.map((b) =>
          React.createElement('div', { key: 'bal-' + b.currency, className: 'dsb-currency-group' },
            React.createElement('div', { className: 'dsb-currency' },
              React.createElement('span', null, b.currency)),
            React.createElement('div', { className: 'dsb-row' },
              React.createElement('span', null, '剩余金额'),
              React.createElement('b', null, b.total))))
      } else if (view.status === 'error') {
        label = '余额不可用'
        tone = 'err'
        chip = React.createElement('span', { className: 'dsb-chip dsb-chip-err' }, '错误')
      }

      let usageBody = null
      if (usage.status === 'loading') {
        usageBody = React.createElement('div', { className: 'dsb-loading' }, '计算中…')
      } else if (usage.status === 'error') {
        usageBody = React.createElement('div', { className: 'dsb-err-text' }, usage.error)
      } else if (usage.status === 'ready' && usage.data) {
        const d = usage.data
        const p = projection
        const hasTokens = p !== undefined && (p.uncachedInputTokens > 0 || p.outputTokens > 0 || p.cacheReadTokens > 0 || p.cacheWriteTokens > 0)
        const hasCost = d.totalCost > 0 || d.models.some((m) => m.cost > 0)
        if (!hasTokens && !hasCost) {
          usageBody = React.createElement('div', { className: 'dsb-note' }, '本会话暂无模型用量')
        } else {
          const rows = []
          if (p !== undefined && hasTokens) {
            const input = p.uncachedInputTokens + p.cacheReadTokens + p.cacheWriteTokens
            const cacheHit = input > 0 ? Math.round(p.cacheReadTokens / input * 100) : null
            rows.push(React.createElement('div', { key: 'u-tok', className: 'dsb-usage-tokens' },
              React.createElement('span', null, 'Tokens · 输入 ' + fmtTokens(input) + ' · 输出 ' + fmtTokens(p.outputTokens)),
              React.createElement('b', null, cacheHit === null ? '' : '缓存 ' + cacheHit + '%')))
          }
          rows.push(React.createElement('div', { key: 'u-cost', className: 'dsb-cost' },
            React.createElement('span', null, '估算费用' + (d.allPriced ? '' : '（部分未收录）')),
            React.createElement('b', { className: 'dsb-amount' }, fmtCost(d.totalCost))))
          if (d.models.length > 1) {
            d.models.forEach((m) => rows.push(React.createElement('div', { key: 'u-m-' + m.model, className: 'dsb-model' },
              React.createElement('span', null, m.model),
              React.createElement('b', null, m.priced ? fmtCost(m.cost) : '—'))))
          }
          rows.push(React.createElement('div', { key: 'u-note', className: 'dsb-note' },
            d.ratesSource === 'live'
              ? '按官方实时价目估算（峰谷分时），实际以账单为准'
              : '按内置价目估算（官方价目获取失败），实际以账单为准'))
          usageBody = React.createElement('div', null, rows)
        }
      } else {
        usageBody = React.createElement('div', { className: 'dsb-loading' }, '计算中…')
      }

      const panel = open
        ? React.createElement('div', { className: 'dsb-panel' },
            React.createElement('div', { className: 'dsb-head' },
              React.createElement('span', null, 'API 概览'),
              chip === null ? React.createElement('span', null) : chip),
            view.status === 'loading'
              ? React.createElement('div', { className: 'dsb-loading' }, '查询中…')
              : view.status === 'error'
                ? React.createElement('div', { className: 'dsb-err-text' }, view.error)
                : React.createElement('div', null,
                    React.createElement('div', { className: 'dsb-sec' }, '账户余额'),
                    balanceRows),
            React.createElement('div', { className: 'dsb-sep' }),
            React.createElement('div', { className: 'dsb-sec' }, '本会话用量'),
            usageBody,
            React.createElement('div', { className: 'dsb-sep' }),
            React.createElement('div', { className: 'dsb-foot' },
              React.createElement('span', null, '更新于 ' + (view.updatedAt ? new Date(view.updatedAt).toLocaleTimeString() : '—')),
              React.createElement('button', { className: 'dsb-refresh', onClick: refresh }, '刷新')))
        : null

      return React.createElement('div', { className: 'dsb-wrap' },
        React.createElement('button', {
          className: 'dsb-badge dsb-' + tone,
          title: '点击查看余额与本会话用量',
          onClick: toggle,
        },
          React.createElement('span', { className: 'dsb-dot' }),
          React.createElement('span', { className: 'dsb-label' }, label)),
        panel)
    }

    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'api-balance-badge', order: 5 },
      (props) => React.createElement(BalanceBadge, {
        sessionId: props.sessionId,
        useProjection: props.useProjection,
      }),
    ))
  },
}
