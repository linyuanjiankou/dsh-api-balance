/**
 * Wire-safe result shapes of the DeepSeek API balance gateway.
 *
 * @module @deepseek-ai/dsh-api-balance/types
 */

/** One currency's balance as reported by the DeepSeek balance endpoint. */
export interface ApiBalanceEntry {
  readonly currency: string
  readonly total: string
  readonly granted: string
  readonly toppedUp: string
}

/** Normalized DeepSeek balance snapshot. */
export interface ApiBalanceData {
  readonly isAvailable: boolean
  readonly balances: readonly ApiBalanceEntry[]
  readonly fetchedAt: number
}

/** One model's accumulated token buckets within a session. */
export interface ApiUsageTokens {
  readonly uncached: number
  readonly out: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** One model's accumulated usage and estimated cost within a session. */
export interface ApiUsageModel {
  readonly model: string
  readonly tokens: ApiUsageTokens
  /** Estimated cost in CNY under the published rate card; 0 when unpriced. */
  readonly cost: number
  /** False when the model has no rate-card entry. */
  readonly priced: boolean
}

/** Per-session usage and estimated cost. */
export interface ApiUsageData {
  readonly totalCost: number
  /** False when at least one model carried no rate-card entry. */
  readonly allPriced: boolean
  readonly models: readonly ApiUsageModel[]
  /** Where the rate card came from: the live official page or the baked fallback. */
  readonly ratesSource: 'live' | 'fallback'
}

/** Common discriminated outcome of every gateway method. */
export type ApiGatewayResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'error'; readonly message: string }
