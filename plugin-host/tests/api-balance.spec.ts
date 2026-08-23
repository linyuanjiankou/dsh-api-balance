import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import ApiBalanceGateway from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

/** Minimal official-page HTML mirroring the Docusaurus price table structure. */
const PRICING_HTML = `
<html><body><table>
<tr><th>模型</th><th>deepseek-v4-flash</th><th>deepseek-v4-pro</th></tr>
<tr></tr>
<tr><td>BASE URL</td><td>https://api.deepseek.com</td></tr>
<tr><td>价格(1)(2)</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td></tr>
<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1.5元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>3.0元</td><td>9.0元</td></tr>
<tr><td>百万tokens输出</td><td>空闲时段</td><td>4.5元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>9.0元</td><td>27.0元</td></tr>
</table></body></html>
`

interface ShellFake {
  resolve: ReturnType<typeof vi.fn<(request: unknown) => unknown>>
  run: ReturnType<typeof vi.fn<(spec: unknown) => Promise<unknown>>>
}

async function harness(options: {
  key?: string | null
  run?: () => Promise<unknown>
  readSession?: () => Promise<unknown>
  webFetch?: () => Promise<unknown>
} = {}): Promise<{ ctx: Context; gateway: ApiBalanceGateway; shell: ShellFake; web: ReturnType<typeof vi.fn> | undefined }> {
  const ctx = new Context()
  contexts.push(ctx)
  const shell: ShellFake = {
    resolve: vi.fn((request: unknown) => request),
    run: vi.fn(async () => (options.run !== undefined
      ? await options.run()
      : { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })),
  }
  const credentials = {
    resolve: vi.fn(async () => (options.key === undefined
      ? { value: 'sk-test', source: 'env' }
      : options.key === null
        ? undefined
        : { value: options.key, source: 'env' })),
  }
  const sessionQuery = {
    readSession: vi.fn(options.readSession ?? (async () => ({ session: {}, events: [] }))),
  }
  let web: ReturnType<typeof vi.fn> | undefined
  if (options.webFetch !== undefined) {
    web = vi.fn(options.webFetch)
    ctx.provide('web', { fetch: web })
  }
  ctx.provide('credentials', credentials)
  ctx.provide('shell', shell as unknown as ShellExecutor)
  ctx.provide('sessionQuery', sessionQuery as unknown as SessionQueryEngine)
  await ctx.plugin(ApiBalanceGateway)
  const gateway = ctx.get('apiBalance') as ApiBalanceGateway
  return { ctx, gateway, shell, web }
}

function messageEvent(
  overrides: {
    turn?: number
    step?: number
    time?: number
    model?: string
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  } = {},
): SessionEvent {
  return {
    seq: 0,
    time: overrides.time ?? 1_700_000_000_000,
    type: 'assistant/message',
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: overrides.model ?? 'deepseek-v4-flash' },
      },
      ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
    },
  } as unknown as SessionEvent
}

function usageChunkEvent(turn: number, step: number, usage: object, time = 1_700_000_000_000): SessionEvent {
  return {
    seq: 0,
    time,
    type: 'assistant/chunk',
    data: { turn, step, chunk: { type: 'usage', usage } },
  } as unknown as SessionEvent
}

function textChunkEvent(turn: number, step: number): SessionEvent {
  return {
    seq: 0,
    time: 1_700_000_000_000,
    type: 'assistant/chunk',
    data: { turn, step, chunk: { type: 'text-delta', index: 0, text: 'x' } },
  } as unknown as SessionEvent
}

const FALLBACK_USAGE = { totalCost: 0, allPriced: true, models: [], ratesSource: 'fallback' }

describe('ApiBalanceGateway', () => {
  it('publishes the two Remote methods under the apiBalance namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'apiBalance', namespace: 'apiBalance' })
  })

  describe('getBalance', () => {
    it('reports an unconfigured key', async () => {
      const { gateway } = await harness({ key: null })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('未配置 DEEPSEEK_API_KEY')
    })

    it('reports an empty stored key', async () => {
      const { gateway } = await harness({ key: '' })
      expect((await gateway.getBalance()).status).toBe('error')
    })

    it('reports a curl failure with stderr detail', async () => {
      const { gateway } = await harness({
        run: async () => ({ exitCode: 7, stdout: { text: '' }, stderr: { text: 'conn refused' } }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('conn refused')
    })

    it('falls back to 无输出 when curl produced nothing', async () => {
      const { gateway } = await harness({
        run: async () => ({ exitCode: 7, stdout: { text: '' }, stderr: { text: '' } }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('无输出')
    })

    it('reports a missing status marker as a failure', async () => {
      const { gateway } = await harness({
        run: async () => ({ exitCode: 0, stdout: { text: 'no marker' }, stderr: { text: '' } }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('http ?')
    })

    it('surfaces the API error message on a non-2xx status', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"error":{"message":"Authentication Fails"}}\n__DSH_STATUS__401' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result).toEqual({ status: 'error', message: 'API 返回 401: Authentication Fails' })
    })

    it('serializes a non-2xx error object without a message', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"error":{"code":42}}\n__DSH_STATUS__500' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('{"code":42}')
    })

    it('uses the raw body when a non-2xx payload is not JSON', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: 'gateway timeout\n__DSH_STATUS__502' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('gateway timeout')
    })

    it('tolerates a non-object error payload on a non-2xx status', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"error":"oops"}\n__DSH_STATUS__503' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result).toEqual({ status: 'error', message: 'API 返回 503: {"error":"oops"}' })
    })

    it('rejects a 2xx body that is not JSON', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: 'not json\n__DSH_STATUS__200' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('不是有效 JSON')
    })

    it('rejects a 2xx non-object body', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '42\n__DSH_STATUS__200' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('不是有效 JSON 对象')
    })

    it('rejects a 2xx body without balance_infos', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"is_available":true}\n__DSH_STATUS__200' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.message).toContain('缺少 balance_infos')
    })

    it('normalizes a successful balance response', async () => {
      const { gateway, shell } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: {
            text: '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":10,"topped_up_balance":null}]}\n__DSH_STATUS__200',
          },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.isAvailable).toBe(true)
        expect(result.data.balances).toEqual([{ currency: 'CNY', total: '110.00', granted: '10', toppedUp: '' }])
        expect(result.data.fetchedAt).toEqual(expect.any(Number))
      }
      const spec = shell.resolve.mock.calls[0]![0] as { command: string; env: Record<string, string> }
      expect(spec.command).not.toContain('sk-test')
      expect(spec.env).toEqual({ DSH_BALANCE_KEY: 'sk-test' })
    })

    it('passes an unavailable flag through', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"is_available":false,"balance_infos":[]}\n__DSH_STATUS__200' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.isAvailable).toBe(false)
    })

    it('coerces non-object balance entries to empty fields', async () => {
      const { gateway } = await harness({
        run: async () => ({
          exitCode: 0,
          stdout: { text: '{"is_available":true,"balance_infos":[42]}\n__DSH_STATUS__200' },
          stderr: { text: '' },
        }),
      })
      const result = await gateway.getBalance()
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.balances).toEqual([{ currency: '', total: '', granted: '', toppedUp: '' }])
      }
    })
  })

  describe('getSessionUsage', () => {
    it('reports a session read failure', async () => {
      const { gateway } = await harness({ readSession: async () => { throw new Error('log missing') } })
      const result = await gateway.getSessionUsage('s1')
      expect(result).toEqual({ status: 'error', message: 'log missing' })
    })

    it('reports a non-Error session read failure', async () => {
      const { gateway } = await harness({ readSession: async () => { throw 'log missing' } })
      const result = await gateway.getSessionUsage('s1')
      expect(result).toEqual({ status: 'error', message: 'log missing' })
    })

    it('returns empty usage for a log without usage events', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [
            textChunkEvent(1, 1),
            messageEvent({}),
            { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
          ],
        }),
      })
      expect(await gateway.getSessionUsage('s1')).toEqual({ status: 'ok', data: FALLBACK_USAGE })
    })

    it('prices one message sample at the off-peak fallback rate', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 4000 } })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.models).toEqual([
          {
            model: 'deepseek-v4-flash',
            tokens: { uncached: 1000, out: 2000, cacheRead: 4000, cacheWrite: 0 },
            cost: (1000 * 1.5 + 4000 * 0.05 + 2000 * 4.5) / 1e6,
            priced: true,
          },
        ])
        expect(result.data.allPriced).toBe(true)
        expect(result.data.ratesSource).toBe('fallback')
      }
    })

    it('doubles the rate during Beijing peak windows', async () => {
      const peakMorning = new Date('2026-08-17T10:00:00+08:00').getTime()
      const peakAfternoon = new Date('2026-08-17T15:00:00+08:00').getTime()
      const offPeak = new Date('2026-08-17T21:00:00+08:00').getTime()
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [
            messageEvent({ time: peakMorning, usage: { inputTokens: 1000, outputTokens: 0 } }),
            messageEvent({ turn: 2, time: peakAfternoon, usage: { inputTokens: 1000, outputTokens: 0 } }),
            messageEvent({ turn: 3, time: offPeak, usage: { inputTokens: 1000, outputTokens: 0 } }),
          ],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.totalCost).toBeCloseTo(5 * 1000 * 1.5 / 1e6, 10)
    })

    it('replaces the usage-chunk sample with the step message sample', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [
            usageChunkEvent(1, 1, { inputTokens: 100, outputTokens: 100 }),
            messageEvent({ usage: { inputTokens: 200, outputTokens: 300 } }),
          ],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.models).toHaveLength(1)
        const model = result.data.models[0]!
        expect(model).toMatchObject({ model: 'deepseek-v4-flash', priced: true })
        expect(model.tokens).toEqual({ uncached: 200, out: 300, cacheRead: 0, cacheWrite: 0 })
      }
    })

    it('keeps a chunk-only step under the unknown model and flags it unpriced', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [usageChunkEvent(1, 1, { inputTokens: 50, outputTokens: 0 })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.models).toEqual([
          { model: 'unknown', tokens: { uncached: 50, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, priced: false },
        ])
        expect(result.data.allPriced).toBe(false)
      }
    })

    it('accumulates multiple steps and sorts models by cost', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [
            messageEvent({ turn: 1, model: 'deepseek-v4-flash', usage: { inputTokens: 1000, outputTokens: 0 } }),
            messageEvent({ turn: 2, model: 'deepseek-v4-pro', usage: { inputTokens: 1000, outputTokens: 0 } }),
            messageEvent({ turn: 3, model: 'deepseek-v4-flash', usage: { inputTokens: 500, outputTokens: 0 } }),
          ],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.data.models.map(m => m.model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
        const flash = result.data.models.find(m => m.model === 'deepseek-v4-flash')
        expect(flash?.tokens.uncached).toBe(1500)
        expect(result.data.models[0]!.cost).toBeCloseTo(1000 * 4.5 / 1e6, 10)
      }
    })

    it('counts cacheWrite tokens at the input-miss rate', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [messageEvent({ usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 } })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.totalCost).toBeCloseTo(1000 * 1.5 / 1e6, 10)
    })

    it('prices the vision-exp model from the fallback table', async () => {
      const { gateway } = await harness({
        readSession: async () => ({
          session: {},
          events: [messageEvent({ model: 'deepseek-v4-flash-vision-exp', usage: { inputTokens: 1000, outputTokens: 0 } })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.totalCost).toBeCloseTo(1000 * 1.5 / 1e6, 10)
    })
  })

  describe('live rate-card resolution', () => {
    const htmlFetch = (html: string) => async () => ({
      url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      statusCode: 200,
      body: { kind: 'html', content: html },
      truncated: false,
    })

    it('parses the official page and prices from the live table', async () => {
      const { gateway, web } = await harness({
        webFetch: htmlFetch(PRICING_HTML),
        readSession: async () => ({
          session: {},
          events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 4000 } })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        // flash off-peak live values equal the fallback, so the cost matches.
        expect(result.data.ratesSource).toBe('live')
        expect(result.data.models[0]!.cost).toBeCloseTo((1000 * 1.5 + 4000 * 0.05 + 2000 * 4.5) / 1e6, 10)
      }
      expect(web).toHaveBeenCalledWith({ url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' })
    })

    it('uses the live peak values when a request falls in a peak window', async () => {
      const peak = new Date('2026-08-17T10:00:00+08:00').getTime()
      const { gateway } = await harness({
        webFetch: htmlFetch(PRICING_HTML),
        readSession: async () => ({
          session: {},
          events: [messageEvent({ time: peak, usage: { inputTokens: 1000, outputTokens: 0 } })],
        }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.totalCost).toBeCloseTo(1000 * 3.0 / 1e6, 10)
    })

    it('falls back to the baked table on a non-200 response', async () => {
      const { gateway } = await harness({
        webFetch: async () => ({
          url: 'x', statusCode: 503, body: { kind: 'html', content: 'oops' }, truncated: false,
        }),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('falls back when the body is not html', async () => {
      const { gateway } = await harness({
        webFetch: async () => ({
          url: 'x', statusCode: 200, body: { kind: 'text', content: 'plain' }, truncated: false,
        }),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('falls back when the page fetch rejects', async () => {
      const { gateway } = await harness({
        webFetch: async () => { throw new Error('network down') },
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('falls back when the page structure is unparsable', async () => {
      const { gateway } = await harness({
        webFetch: htmlFetch('<html><body><table><tr><td>no prices here</td></tr></table></body></html>'),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('falls back when the page has a header but no price rows', async () => {
      const { gateway } = await harness({
        webFetch: htmlFetch('<html><body><table><tr><th>模型</th><th>deepseek-v4-flash</th></tr></table></body></html>'),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('falls back when a price cell carries no number', async () => {
      const broken = PRICING_HTML.replace('1.5元', '待定')
      const { gateway } = await harness({
        webFetch: htmlFetch(broken),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      const result = await gateway.getSessionUsage('s1')
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.data.ratesSource).toBe('fallback')
    })

    it('caches the fetched table within the TTL and re-fetches after it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const base = 1_700_000_000_000
      vi.setSystemTime(base)
      const { gateway, web } = await harness({
        webFetch: htmlFetch(PRICING_HTML),
        readSession: async () => ({ session: {}, events: [messageEvent({ usage: { inputTokens: 1000, outputTokens: 0 } })] }),
      })
      await gateway.getSessionUsage('s1')
      await gateway.getSessionUsage('s1')
      expect(web).toHaveBeenCalledTimes(1)
      vi.setSystemTime(base + 6 * 3_600_000 + 1)
      await gateway.getSessionUsage('s1')
      expect(web).toHaveBeenCalledTimes(2)
    })
  })
})
