// dsh-api-balance — dynamic-plugin Host half
// 用途：在 cordis_define 的 code.host 中粘贴本文件内容（保留 `return { ... }` 函数体本身）。
// 依赖：DEEPSEEK_API_KEY 已配置（进程环境变量 / ~/.dsh/.env / 项目 .env / 凭据仓库）。
// 价目：运行时抓取官方价格页自动更新，失败回退内置表（见 loadRates）。
return {
  apply(ctx) {
    // ---- 账户余额 ----
    harness.handle('get-balance', async () => {
      const credentials = ctx.get('credentials')
      const shell = ctx.get('shell')
      if (credentials === undefined || shell === undefined) {
        return { ok: false, error: '主机服务不可用（credentials / shell）' }
      }
      try {
        const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
        if (resolved === undefined || !resolved.value) {
          return { ok: false, error: '未配置 DEEPSEEK_API_KEY。请设置环境变量，或在 ~/.dsh/.env 中添加 DEEPSEEK_API_KEY=<你的Key>' }
        }
        const spec = shell.resolve({
          command: 'curl -sS -m 15 -H "Authorization: Bearer $DSH_BALANCE_KEY" -H "Accept: application/json" https://api.deepseek.com/user/balance -w "\\n__DSH_STATUS__%{http_code}"',
          env: { DSH_BALANCE_KEY: resolved.value },
          timeoutMs: 20000,
          stdoutMaxBytes: 65536,
        })
        const result = await shell.run(spec)
        const stdout = result.stdout.text || ''
        const marker = '\n__DSH_STATUS__'
        const idx = stdout.lastIndexOf(marker)
        let statusText = ''
        let bodyText = stdout
        if (idx !== -1) {
          statusText = stdout.slice(idx + marker.length).trim()
          bodyText = stdout.slice(0, idx)
        }
        const status = Number(statusText)
        if (result.exitCode !== 0 || !statusText) {
          const detail = (result.stderr.text || stdout || '无输出').slice(0, 300)
          return { ok: false, error: '请求失败（exit ' + result.exitCode + ', http ' + (statusText || '?') + '）: ' + detail }
        }
        let payload = null
        try {
          payload = JSON.parse(bodyText)
        } catch (e) {
          return { ok: false, error: '响应不是有效 JSON（http ' + status + '）: ' + bodyText.slice(0, 200) }
        }
        if (status < 200 || status >= 300) {
          const apiMsg = payload && payload.error && (payload.error.message || JSON.stringify(payload.error))
          return { ok: false, error: 'API 返回 ' + status + ': ' + (apiMsg || bodyText.slice(0, 200)) }
        }
        const balances = Array.isArray(payload.balance_infos)
          ? payload.balance_infos.map((b) => ({
              currency: String(b.currency || ''),
              total: String(b.total_balance !== undefined && b.total_balance !== null ? b.total_balance : ''),
              granted: String(b.granted_balance !== undefined && b.granted_balance !== null ? b.granted_balance : ''),
              toppedUp: String(b.topped_up_balance !== undefined && b.topped_up_balance !== null ? b.topped_up_balance : ''),
            }))
          : []
        return { ok: true, data: { isAvailable: payload.is_available === true, balances, fetchedAt: Date.now() } }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    })

    // ---- 本会话用量与费用估算 ----
    // 价目自动更新：运行时抓取官方价格页，失败回退内置表。
    const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
    const RATES_TTL = 6 * 3600 * 1000

    // 内置回退价目（元/百万 tokens；官方页面不可达时使用）
    const FALLBACK_RATES = {
      'deepseek-v4-flash': { off: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }, peak: { inputMiss: 3.0, inputHit: 0.10, output: 9.0 } },
      'deepseek-v4-pro': { off: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 }, peak: { inputMiss: 9.0, inputHit: 0.30, output: 27.0 } },
      'deepseek-v4-flash-vision-exp': { off: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }, peak: { inputMiss: 3.0, inputHit: 0.10, output: 9.0 } },
      'deepseek-chat': { off: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }, peak: { inputMiss: 3.0, inputHit: 0.10, output: 9.0 } },
      'deepseek-reasoner': { off: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }, peak: { inputMiss: 3.0, inputHit: 0.10, output: 9.0 } },
    }

    // 北京高峰时段 09:00-12:00、14:00-18:00（无夏令时，固定 +8）
    const isPeak = (timeMs) => {
      const bj = new Date(timeMs + 8 * 3600 * 1000)
      const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes()
      return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080)
    }

    // 解析官方价格页（Docusaurus 表格，中文标签）
    const parseRateTable = (htmlText) => {
      const rows = [...htmlText.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      const cellsOf = (row) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
        .map((m) => (m[1] || '').replace(/<[^>]+>/g, '').trim())
      const table = {}
      let models = []
      let bucket = null
      for (const row of rows) {
        const cells = cellsOf(row[1] || '')
        if (cells.length === 0) continue
        const first = cells[0] || ''
        if (first === '模型' && cells.length > 1) {
          models = cells.slice(1)
          for (const model of models) {
            table[model] = { off: { inputMiss: 0, inputHit: 0, output: 0 }, peak: { inputMiss: 0, inputHit: 0, output: 0 } }
          }
          continue
        }
        const joined = cells.join(' ')
        if (joined.indexOf('缓存未命中') !== -1) bucket = 'inputMiss'
        else if (joined.indexOf('缓存命中') !== -1) bucket = 'inputHit'
        else if (joined.indexOf('输出') !== -1) bucket = 'output'
        const tier = joined.indexOf('高峰时段') !== -1 ? 'peak' : joined.indexOf('空闲时段') !== -1 ? 'off' : null
        const firstModel = models[0]
        if (tier === null || bucket === null || firstModel === undefined || table[firstModel] === undefined) continue
        const tierIndex = cells.findIndex((c) => c.indexOf('时段') !== -1)
        const values = cells.slice(tierIndex + 1).map((c) => {
          const m = /(\d+(?:\.\d+)?)/.exec(c)
          return m === null ? null : Number(m[1])
        })
        models.forEach((model, index) => {
          const value = values[index]
          const entry = table[model]
          if (value === null || value === undefined || entry === undefined) return
          entry[tier][bucket] = value
        })
      }
      for (const entry of Object.values(table)) {
        if (entry.off.inputMiss <= 0 || entry.off.inputHit < 0 || entry.off.output <= 0
          || entry.peak.inputMiss <= 0 || entry.peak.inputHit < 0 || entry.peak.output <= 0) {
          return null
        }
      }
      return Object.keys(table).length === 0 ? null : table
    }

    let ratesCache = null
    const loadRates = async () => {
      const now = Date.now()
      if (ratesCache !== null && now - ratesCache.at < RATES_TTL) return ratesCache
      let table = FALLBACK_RATES
      let live = false
      const web = ctx.get('web')
      if (web !== undefined) {
        try {
          const result = await web.fetch({ url: PRICING_URL })
          if (result.statusCode === 200 && result.body && result.body.kind === 'html') {
            const parsed = parseRateTable(result.body.content)
            if (parsed !== null) {
              table = parsed
              live = true
            }
          }
        } catch (e) {
          // 官方页面不可达时使用内置回退价目，不阻断用量计算
        }
      }
      ratesCache = { table, at: now, live }
      return ratesCache
    }

    harness.handle('get-session-usage', async (args) => {
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) return { ok: false, error: 'sessionQuery 服务不可用' }
      try {
        const sessionId = args && args.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少 sessionId' }
        const [snapshot, rates] = await Promise.all([sessionQuery.readSession(sessionId), loadRates()])
        const events = (snapshot && snapshot.events) || []
        const byModel = new Map()
        let last = null
        const bump = (model, key, delta) => {
          let m = byModel.get(model)
          if (!m) {
            m = { model, uncached: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false }
            byModel.set(model, m)
          }
          m[key] += delta
        }
        const applyCost = (model, sign, buckets, timeMs) => {
          const rate = rates.table[model]
          if (rate === undefined) return
          const level = isPeak(timeMs) ? rate.peak : rate.off
          const m = byModel.get(model)
          m.cost += sign * ((buckets.uncached + buckets.cacheWrite) * level.inputMiss
            + buckets.cacheRead * level.inputHit
            + buckets.out * level.output) / 1e6
          m.priced = true
        }
        for (const e of events) {
          let usage = null
          if (e.type === 'assistant/chunk' && e.data && e.data.chunk && e.data.chunk.type === 'usage' && e.data.chunk.usage) {
            usage = e.data.chunk.usage
          } else if (e.type === 'assistant/message' && e.data && e.data.usage) {
            usage = e.data.usage
          }
          if (!usage) continue
          const turn = e.data.turn
          const step = e.data.step
          const src = e.type === 'assistant/message' && e.data.message ? e.data.message.source : undefined
          const model = (src && src.kind === 'model' && typeof src.model === 'string') ? src.model : 'unknown'
          const buckets = {
            uncached: usage.inputTokens || 0,
            out: usage.outputTokens || 0,
            cacheRead: usage.cacheReadTokens || 0,
            cacheWrite: usage.cacheWriteTokens || 0,
          }
          // 同一 turn/step 的重复采样（usage chunk -> 最终 message）替换而非累加
          if (last !== null && last.turn === turn && last.step === step) {
            const m = byModel.get(last.model)
            if (m) {
              m.uncached -= last.buckets.uncached
              m.out -= last.buckets.out
              m.cacheRead -= last.buckets.cacheRead
              m.cacheWrite -= last.buckets.cacheWrite
              applyCost(last.model, -1, last.buckets, last.time)
            }
          }
          bump(model, 'uncached', buckets.uncached)
          bump(model, 'out', buckets.out)
          bump(model, 'cacheRead', buckets.cacheRead)
          bump(model, 'cacheWrite', buckets.cacheWrite)
          applyCost(model, 1, buckets, e.time)
          last = { turn, step, model, buckets, time: e.time }
        }
        const models = []
        let totalCost = 0
        let allPriced = true
        for (const m of byModel.values()) {
          const hasTokens = m.uncached + m.out + m.cacheRead + m.cacheWrite !== 0
          if (!hasTokens && m.cost === 0) continue
          models.push({
            model: m.model,
            tokens: { uncached: m.uncached, out: m.out, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite },
            cost: Math.round(m.cost * 1e6) / 1e6,
            priced: m.priced,
          })
          totalCost += m.cost
          if (!m.priced) allPriced = false
        }
        models.sort((a, b) => b.cost - a.cost)
        return { ok: true, data: { totalCost: Math.round(totalCost * 1e6) / 1e6, allPriced, models, ratesSource: rates.live ? 'live' : 'fallback' } }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    })
  },
}
