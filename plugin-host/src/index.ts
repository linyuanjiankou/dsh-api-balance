/**
 * DeepSeek API balance and per-session usage/cost gateway.
 *
 * `getBalance` reads the DeepSeek balance endpoint through the shell provider:
 * curl carries the Authorization header from an explicit env entry, never on
 * the command line, so the key never appears in a process list. `getSessionUsage`
 * replays a session's durable log and folds provider-reported usage into
 * per-model token buckets plus a peak/off-peak-aware cost estimate.
 *
 * The rate card is resolved at runtime: the service fetches the official
 * DeepSeek pricing page through the web provider and parses the price table,
 * caching it for {@link RATES_TTL}. When the page is unreachable or unparsable
 * it falls back to the baked {@link FALLBACK_RATES}, so price changes on the
 * official page apply automatically without a code update.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-session-query'
import type { WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  ApiBalanceData,
  ApiBalanceEntry,
  ApiGatewayResult,
  ApiUsageData,
  ApiUsageModel,
} from './types.ts'

export type * from './types.ts'

/** Official pricing page the rate table is parsed from (server-rendered Docusaurus HTML). */
const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** How long a fetched rate table is reused before the page is re-fetched. */
const RATES_TTL = 6 * 3_600_000

/** One bucket's price at one usage tier, in CNY per 1M tokens. */
interface PriceLevels {
  inputMiss: number
  inputHit: number
  output: number
}

/** One model's off-peak and peak (doubled) price levels. */
interface ModelRates {
  off: PriceLevels
  peak: PriceLevels
}

/** Baked fallback rate card (CNY per 1M tokens), used when the live page is unavailable. */
const FALLBACK_RATES: Readonly<Record<string, ModelRates>> = {
  'deepseek-flash': {
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
  },
  'deepseek-v4-pro': {
    off: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
    peak: { inputMiss: 9.0, inputHit: 0.30, output: 27.0 },
  },
  // Superseded flash names: the pricing page still documents them as callable
  // aliases of the current flash model, so they carry its rate.
  'deepseek-v4-flash': {
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
  },
  'deepseek-v4-flash-vision-exp': {
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
  },
  'deepseek-chat': {
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
  },
  'deepseek-reasoner': {
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
  },
}

/** Beijing peak windows (09:00-12:00 and 14:00-18:00); no DST, fixed +8. */
function isBeijingPeak(timeMs: number): boolean {
  const beijing = new Date(timeMs + 8 * 3_600_000)
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** Strip HTML tags from one pricing cell. */
function stripTags(cell: string): string {
  return cell.replace(/<[^>]+>/g, '')
}

/** Parse the leading decimal from a price cell like `1.5元`; null when absent. */
function parsePrice(cell: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(cell)
  return match === null ? null : Number(match[1])
}

/**
 * Parse the model price table out of the official pricing page HTML.
 * The Docusaurus table has one header row (model names) followed by price rows
 * whose first cell names the bucket (输入缓存命中 / 输入缓存未命中 / 输出); the
 * 空闲时段/高峰时段 rows carry the per-model values, reusing the bucket named
 * by the row above. Returns null when the structure is missing or incomplete.
 *
 * Model names come from the page, so a newly published generation is picked up
 * without a code change; each header cell drops its `<sup>` footnote marker
 * (`deepseek-flash<sup>(1)</sup>` is the model id `deepseek-flash`).
 * @param htmlText - the pricing page body.
 * @returns model -> off/peak price levels, or null.
 */
function parseRateTable(htmlText: string): Record<string, ModelRates> | null {
  const rows = [...htmlText.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  const cellsOf = (row: string): string[] => (
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map(match => stripTags((match[1] ?? '').replace(/<sup[\s\S]*?<\/sup>/g, '')).trim())
  )
  const table: Record<string, ModelRates> = {}
  let models: string[] = []
  let bucket: 'inputMiss' | 'inputHit' | 'output' | null = null
  for (const row of rows) {
    const cells = cellsOf(row[1] ?? '')
    if (cells.length === 0) continue
    const firstCell = cells[0] ?? ''
    if (firstCell === '模型' && cells.length > 1) {
      // A trailing footnote reference that survived as text (`deepseek-flash(1)`)
      // is not part of the model id.
      models = cells.slice(1).map(name => name.replace(/[(（]\d+[)）]\s*$/, '').trim())
      for (const model of models) {
        table[model] = { off: { inputMiss: 0, inputHit: 0, output: 0 }, peak: { inputMiss: 0, inputHit: 0, output: 0 } }
      }
      continue
    }
    const joined = cells.join(' ')
    if (/缓存未命中/.test(joined)) bucket = 'inputMiss'
    else if (/缓存命中/.test(joined)) bucket = 'inputHit'
    else if (/输出/.test(joined)) bucket = 'output'
    const tier = /高峰时段/.test(joined) ? 'peak' : /空闲时段/.test(joined) ? 'off' : null
    const firstModel = models[0]
    if (tier === null || bucket === null || firstModel === undefined || table[firstModel] === undefined) continue
    // Fix the narrowed union in consts so the closure below keeps it.
    const priceTier = tier
    const priceBucket = bucket
    const tierIndex = cells.findIndex(cell => /时段/.test(cell))
    const values = cells.slice(tierIndex + 1).map(parsePrice)
    models.forEach((model, index) => {
      const value = values[index]
      const entry = table[model]
      if (value === null || value === undefined || entry === undefined) return
      entry[priceTier][priceBucket] = value
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

/** One step's reported token buckets. */
interface TokenBuckets {
  readonly uncached: number
  readonly out: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** One model's running fold within a session. */
interface ModelAccount {
  readonly model: string
  uncached: number
  out: number
  cacheRead: number
  cacheWrite: number
  cost: number
  priced: boolean
}

/** The provider usage a surface event carries, plus its owning model. */
function usageSample(
  event: SessionEvent,
): { usage: TokenUsage; model: string; turn: number; step: number } | null {
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk
    if (chunk.type !== 'usage') return null
    // A usage chunk predates its step's final message, which carries the model.
    return { usage: chunk.usage, model: 'unknown', turn: event.data.turn, step: event.data.step }
  }
  if (event.type === 'assistant/message') {
    const usage = event.data.usage
    if (usage === undefined) return null
    return {
      usage,
      model: event.data.message.source.model,
      turn: event.data.turn,
      step: event.data.step,
    }
  }
  return null
}

/** Apply one signed bucket delta and its cost to a model account. */
function applyBuckets(
  byModel: Map<string, ModelAccount>,
  model: string,
  sign: 1 | -1,
  buckets: TokenBuckets,
  timeMs: number,
  rates: Readonly<Record<string, ModelRates>>,
): void {
  const account = byModel.get(model) ?? {
    model,
    uncached: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    priced: false,
  }
  account.uncached += sign * buckets.uncached
  account.out += sign * buckets.out
  account.cacheRead += sign * buckets.cacheRead
  account.cacheWrite += sign * buckets.cacheWrite
  const rate = rates[model]
  if (rate !== undefined) {
    const level = isBeijingPeak(timeMs) ? rate.peak : rate.off
    account.cost += sign * (
      (buckets.uncached + buckets.cacheWrite) * level.inputMiss
      + buckets.cacheRead * level.inputHit
      + buckets.out * level.output
    ) / 1_000_000
    account.priced = true
  }
  byModel.set(model, account)
}

/** Fold the accumulated accounts into the wire result, dropping netted-out placeholders. */
function toUsageData(byModel: Map<string, ModelAccount>, ratesSource: ApiUsageData['ratesSource']): ApiUsageData {
  const models: ApiUsageModel[] = []
  let totalCost = 0
  let allPriced = true
  for (const account of byModel.values()) {
    const hasTokens = account.uncached + account.out + account.cacheRead + account.cacheWrite !== 0
    if (!hasTokens && account.cost === 0) continue
    models.push({
      model: account.model,
      tokens: {
        uncached: account.uncached,
        out: account.out,
        cacheRead: account.cacheRead,
        cacheWrite: account.cacheWrite,
      },
      cost: Math.round(account.cost * 1_000_000) / 1_000_000,
      priced: account.priced,
    })
    totalCost += account.cost
    if (!account.priced) allPriced = false
  }
  models.sort((a, b) => b.cost - a.cost)
  return { totalCost: Math.round(totalCost * 1_000_000) / 1_000_000, allPriced, models, ratesSource }
}

/** Decode one balance-endpoint body into entries, or a failure message. */
function parseBalanceBody(body: string): { balances: ApiBalanceEntry[]; isAvailable: boolean } | { message: string } {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { message: '响应不是有效 JSON' }
  }
  if (typeof value !== 'object' || value === null) return { message: '响应不是有效 JSON 对象' }
  const record = value as Record<string, unknown>
  const infos = record.balance_infos
  if (!Array.isArray(infos)) return { message: '响应缺少 balance_infos' }
  const stringOf = (candidate: unknown): string => (
    typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : ''
  )
  const balances = infos.map((entry): ApiBalanceEntry => {
    const fields = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    return {
      currency: stringOf(fields.currency),
      total: stringOf(fields.total_balance),
      granted: stringOf(fields.granted_balance),
      toppedUp: stringOf(fields.topped_up_balance),
    }
  })
  return { balances, isAvailable: record.is_available === true }
}

/** Extract the API's own error message from a non-2xx payload, if present. */
function apiErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const error = (payload as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' ? message : JSON.stringify(error)
}

/** DeepSeek balance and per-session usage Remote gateway. */
export class ApiBalanceGateway extends TypertRemoteService {
  static inject = ['credentials', 'shell', 'sessionQuery']

  /** Cached rate table: the parsed live card when available, else the baked fallback. */
  private ratesCache: { table: Readonly<Record<string, ModelRates>>; at: number; live: boolean } | null = null

  constructor(ctx: Context) {
    super(ctx, 'apiBalance')
  }

  /**
   * Resolve the rate card, re-fetching the official page at most once per TTL.
   * @returns the table and whether it came from the live page.
   */
  private async loadRates(): Promise<{ table: Readonly<Record<string, ModelRates>>; live: boolean }> {
    const now = Date.now()
    if (this.ratesCache !== null && now - this.ratesCache.at < RATES_TTL) return this.ratesCache
    let table: Readonly<Record<string, ModelRates>> = FALLBACK_RATES
    let live = false
    const web = this.ctx.get('web') as { fetch(request: WebFetchRequest): Promise<WebFetchResult> } | undefined
    if (web !== undefined) {
      try {
        const result = await web.fetch({ url: PRICING_URL })
        if (result.statusCode === 200 && result.body.kind === 'html') {
          const parsed = parseRateTable(result.body.content)
          if (parsed !== null) {
            // Overlay the live card on the baked one: the page lists only the
            // models it currently markets, while the fallback still carries the
            // superseded names older sessions recorded. Live entries win.
            table = { ...FALLBACK_RATES, ...parsed }
            live = true
          }
        }
      } catch {
        // The official page being unreachable must not fail the usage fold;
        // the baked fallback still prices the session.
      }
    }
    this.ratesCache = { table, at: now, live }
    return this.ratesCache
  }

  /**
   * Read the account balance from the DeepSeek balance endpoint.
   * @returns normalized balance entries or a user-facing failure message.
   */
  @Remote('getBalance')
  async getBalance(): Promise<ApiGatewayResult<ApiBalanceData>> {
    const resolved = await this.ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
    if (resolved === undefined || resolved.value === '') {
      return {
        status: 'error',
        message: '未配置 DEEPSEEK_API_KEY。请设置环境变量，或在 ~/.dsh/.env 中添加 DEEPSEEK_API_KEY=<你的Key>',
      }
    }
    const spec = this.ctx.shell.resolve({
      command: 'curl -sS -m 15 -H "Authorization: Bearer $DSH_BALANCE_KEY" -H "Accept: application/json" https://api.deepseek.com/user/balance -w "\\n__DSH_STATUS__%{http_code}"',
      env: { DSH_BALANCE_KEY: resolved.value },
      timeoutMs: 20_000,
      stdoutMaxBytes: 65_536,
    })
    const result = await this.ctx.shell.run(spec)
    const stdout = result.stdout.text
    const marker = '\n__DSH_STATUS__'
    const markerIndex = stdout.lastIndexOf(marker)
    let statusText = ''
    let bodyText = stdout
    if (markerIndex !== -1) {
      statusText = stdout.slice(markerIndex + marker.length).trim()
      bodyText = stdout.slice(0, markerIndex)
    }
    const status = Number(statusText)
    if (result.exitCode !== 0 || !statusText) {
      const detail = (result.stderr.text || stdout || '无输出').slice(0, 300)
      return { status: 'error', message: `请求失败（exit ${result.exitCode}, http ${statusText || '?'}）: ${detail}` }
    }
    if (status < 200 || status >= 300) {
      let payload: unknown = null
      try {
        payload = JSON.parse(bodyText)
      } catch {
        // The status alone still names the failure.
      }
      const apiMessage = apiErrorMessage(payload) ?? bodyText.slice(0, 200)
      return { status: 'error', message: `API 返回 ${status}: ${apiMessage}` }
    }
    const parsed = parseBalanceBody(bodyText)
    if ('message' in parsed) return { status: 'error', message: `${parsed.message}（http ${status}）: ${bodyText.slice(0, 200)}` }
    return { status: 'ok', data: { isAvailable: parsed.isAvailable, balances: parsed.balances, fetchedAt: Date.now() } }
  }

  /**
   * Fold one session's durable log into per-model token buckets and estimated cost.
   * @param sessionId - wire session id (branded at this boundary).
   * @returns usage data or a user-facing failure message.
   */
  @Remote('getSessionUsage')
  async getSessionUsage(sessionId: string): Promise<ApiGatewayResult<ApiUsageData>> {
    try {
      const [snapshot, rates] = await Promise.all([
        this.ctx.sessionQuery.readSession(sessionId as SessionId),
        this.loadRates(),
      ])
      const byModel = new Map<string, ModelAccount>()
      let last: { turn: number; step: number; model: string; buckets: TokenBuckets; time: number } | null = null
      for (const event of snapshot.events) {
        const sample = usageSample(event)
        if (sample === null) continue
        const buckets: TokenBuckets = {
          uncached: sample.usage.inputTokens,
          out: sample.usage.outputTokens,
          cacheRead: sample.usage.cacheReadTokens ?? 0,
          cacheWrite: sample.usage.cacheWriteTokens ?? 0,
        }
        // A usage chunk is the early sample for its step; the final message
        // sample replaces it instead of double counting (the log guarantees
        // one step's reports are adjacent).
        if (last !== null && last.turn === sample.turn && last.step === sample.step) {
          applyBuckets(byModel, last.model, -1, last.buckets, last.time, rates.table)
        }
        applyBuckets(byModel, sample.model, 1, buckets, event.time, rates.table)
        last = { turn: sample.turn, step: sample.step, model: sample.model, buckets, time: event.time }
      }
      return { status: 'ok', data: toUsageData(byModel, rates.live ? 'live' : 'fallback') }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
}

export default ApiBalanceGateway
