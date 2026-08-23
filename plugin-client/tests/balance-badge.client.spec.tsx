// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiBalanceBadge, type ApiBalanceBadgeProps } from '../src/client/BalanceBadge.tsx'

afterEach(cleanup)

const BALANCE_OK = {
  status: 'ok' as const,
  data: {
    isAvailable: true,
    balances: [{ currency: 'CNY', total: '110.00', granted: '10', toppedUp: '100' }],
    fetchedAt: 0,
  },
}
const BALANCE_UNAVAILABLE = {
  status: 'ok' as const,
  data: { isAvailable: false, balances: [], fetchedAt: 0 },
}
const USAGE_OK = {
  status: 'ok' as const,
  data: {
    totalCost: 0.653,
    allPriced: true,
    ratesSource: 'live' as const,
    models: [
      { model: 'deepseek-v4-flash', tokens: { uncached: 91_117, out: 64_725, cacheRead: 4_497_920, cacheWrite: 0 }, cost: 0.653, priced: true },
    ],
  },
}
const USAGE_TWO_MODELS = {
  status: 'ok' as const,
  data: {
    totalCost: 1.5,
    allPriced: false,
    ratesSource: 'fallback' as const,
    models: [
      { model: 'deepseek-v4-pro', tokens: { uncached: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1.2, priced: true },
      { model: 'other-model', tokens: { uncached: 500, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, priced: false },
    ],
  },
}
const EMPTY_PROJECTION = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
const HIT_PROJECTION = { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 0 }

function renderBadge(options: {
  balance?: unknown
  usage?: unknown
  projection?: unknown
  getBalance?: ReturnType<typeof vi.fn>
  getSessionUsage?: ReturnType<typeof vi.fn>
} = {}) {
  const getBalance = options.getBalance ?? vi.fn(async () => options.balance ?? BALANCE_OK)
  const getSessionUsage = options.getSessionUsage ?? vi.fn(async () => options.usage ?? USAGE_OK)
  const props = {
    sessionId: 's1',
    useProjection: () => options.projection ?? EMPTY_PROJECTION,
    getBalance,
    getSessionUsage,
  } as unknown as ApiBalanceBadgeProps
  const view = render(<ApiBalanceBadge {...props} />)
  return { getBalance, getSessionUsage, view }
}

const badgeButton = (): HTMLElement => screen.getAllByRole('button')[0]!

describe('ApiBalanceBadge', () => {
  it('shows the primary balance in the badge once loaded', async () => {
    renderBadge()
    expect(screen.getAllByText('查询中…').length).toBeGreaterThan(0)
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
  })

  it('shows 余额 0 for an account without balances', async () => {
    renderBadge({ balance: BALANCE_UNAVAILABLE })
    await waitFor(() => { expect(screen.getByText('余额 0')).toBeTruthy() })
  })

  it('shows an error label when the balance fetch fails', async () => {
    renderBadge({ balance: { status: 'error', message: '未配置 DEEPSEEK_API_KEY' } })
    await waitFor(() => { expect(screen.getByText('余额不可用')).toBeTruthy() })
  })

  it('handles a rejected balance fetch', async () => {
    const getBalance = vi.fn(async () => { throw new Error('network down') })
    renderBadge({ getBalance })
    await waitFor(() => { expect(screen.getByText('余额不可用')).toBeTruthy() })
  })

  it('handles a non-Error balance rejection', async () => {
    const getBalance = vi.fn(async () => { throw 'boom-string' })
    renderBadge({ getBalance })
    await waitFor(() => { expect(screen.getByText('余额不可用')).toBeTruthy() })
  })

  it('renders the balance failure inside the panel', async () => {
    renderBadge({ balance: { status: 'error', message: 'API 返回 401: Authentication Fails' } })
    await waitFor(() => { expect(screen.getByText('余额不可用')).toBeTruthy() })
    fireEvent.click(badgeButton())
    expect(screen.getByText('API 返回 401: Authentication Fails')).toBeTruthy()
  })

  it('opens the overview panel on click and renders balance plus usage', async () => {
    const { getSessionUsage } = renderBadge({ projection: HIT_PROJECTION })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    expect(screen.queryByText('API 概览')).toBeNull()

    fireEvent.click(badgeButton())
    expect(screen.getByText('API 概览')).toBeTruthy()
    expect(screen.getByText('可用')).toBeTruthy()
    expect(screen.getByText('账户余额')).toBeTruthy()
    expect(screen.getByText('剩余金额')).toBeTruthy()
    expect(screen.getByText('110.00')).toBeTruthy()
    await waitFor(() => { expect(getSessionUsage).toHaveBeenCalledWith('s1') })
    await waitFor(() => { expect(screen.getByText(/Tokens · 输入 5K · 输出 500/)).toBeTruthy() })
    expect(screen.getByText('缓存 80%')).toBeTruthy()
    expect(screen.getByText('¥0.6530')).toBeTruthy()
    expect(screen.getByText('本会话用量')).toBeTruthy()
    expect(screen.getByText(/按官方实时价目估算/)).toBeTruthy()
    expect(screen.getByText('刷新')).toBeTruthy()

    fireEvent.click(badgeButton())
    expect(screen.queryByText('API 概览')).toBeNull()
  })

  it('shows a placeholder updated time and loading body while the balance is pending', async () => {
    const deferred = Promise.withResolvers<unknown>()
    const getBalance = vi.fn(() => deferred.promise)
    renderBadge({ getBalance })
    fireEvent.click(badgeButton())
    expect(screen.getByText('更新于 —')).toBeTruthy()
    expect(screen.getAllByText('查询中…').length).toBeGreaterThan(0)
    await act(async () => { deferred.resolve(BALANCE_OK) })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
  })

  it('shows the loading and error states of the usage section', async () => {
    const deferred = Promise.withResolvers<unknown>()
    const getSessionUsage = vi.fn(() => deferred.promise)
    renderBadge({ getSessionUsage })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    expect(screen.getByText('计算中…')).toBeTruthy()
    await act(async () => { deferred.resolve({ status: 'error', message: 'log missing' }) })
    expect(screen.getByText('log missing')).toBeTruthy()
  })

  it('shows a rejection from the usage fetch', async () => {
    const getSessionUsage = vi.fn(async () => { throw new Error('boom') })
    renderBadge({ getSessionUsage })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('shows a non-Error rejection from the usage fetch', async () => {
    const getSessionUsage = vi.fn(async () => { throw 'boom-string' })
    renderBadge({ getSessionUsage })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText('boom-string')).toBeTruthy() })
  })

  it('shows the empty-usage note when nothing was billed', async () => {
    renderBadge({ usage: { status: 'ok', data: { totalCost: 0, allPriced: true, models: [], ratesSource: 'fallback' } } })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText('本会话暂无模型用量')).toBeTruthy() })
  })

  it('omits the cache percentage when no input was billed', async () => {
    renderBadge({ projection: { ...EMPTY_PROJECTION, outputTokens: 7 } })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText(/Tokens · 输入 0 · 输出 7/)).toBeTruthy() })
    expect(screen.queryByText(/缓存/)).toBeNull()
  })

  it('formats token counts in millions', async () => {
    renderBadge({ projection: { ...EMPTY_PROJECTION, uncachedInputTokens: 2_000_000 } })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText(/Tokens · 输入 2M · 输出 0/)).toBeTruthy() })
  })

  it('derives the cost row from per-model cost when the total is zero', async () => {
    renderBadge({
      projection: EMPTY_PROJECTION,
      usage: {
        status: 'ok' as const,
        data: {
          totalCost: 0,
          allPriced: false,
          ratesSource: 'fallback' as const,
          models: [
            { model: 'm1', tokens: { uncached: 100, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, priced: true },
          ],
        },
      },
    })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText('估算费用（部分未收录）')).toBeTruthy() })
    expect(screen.getByText('¥0.0000')).toBeTruthy()
  })

  it('notes when the cost used the baked fallback rate card', async () => {
    renderBadge({
      projection: EMPTY_PROJECTION,
      usage: {
        status: 'ok' as const,
        data: {
          totalCost: 0.1,
          allPriced: true,
          ratesSource: 'fallback' as const,
          models: [
            { model: 'deepseek-v4-flash', tokens: { uncached: 100, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.1, priced: true },
          ],
        },
      },
    })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText(/按内置价目估算（官方价目获取失败）/)).toBeTruthy() })
  })

  it('breaks cost down per model and flags unpriced models', async () => {
    renderBadge({ usage: USAGE_TWO_MODELS, projection: EMPTY_PROJECTION })
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(screen.getByText('deepseek-v4-pro')).toBeTruthy() })
    expect(screen.getByText('deepseek-v4-pro')).toBeTruthy()
    expect(screen.getByText('¥1.20')).toBeTruthy()
    expect(screen.getByText('other-model')).toBeTruthy()
    expect(screen.getByText('估算费用（部分未收录）')).toBeTruthy()
  })

  it('refreshes both sections from the panel button', async () => {
    const { getBalance, getSessionUsage } = renderBadge()
    await waitFor(() => { expect(screen.getByText('CNY 110.00')).toBeTruthy() })
    fireEvent.click(badgeButton())
    await waitFor(() => { expect(getSessionUsage).toHaveBeenCalled() })
    fireEvent.click(screen.getByText('刷新'))
    expect(getBalance).toHaveBeenCalledTimes(2)
    expect(getSessionUsage).toHaveBeenCalledTimes(2)
  })
})
