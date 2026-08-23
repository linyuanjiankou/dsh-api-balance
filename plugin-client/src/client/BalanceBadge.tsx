import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ApiBalanceData, ApiGatewayResult, ApiUsageData } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import css from './BalanceBadge.module.css'

/** Browser operations injected into the Session Header contribution. */
export interface ApiBalanceBadgeInjected {
  getBalance: () => Promise<ApiGatewayResult<ApiBalanceData>>
  getSessionUsage: (sessionId: string) => Promise<ApiGatewayResult<ApiUsageData>>
}

export type ApiBalanceBadgeProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<ApiBalanceBadgeInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: ApiBalanceData; readonly updatedAt: number }
  | { readonly status: 'error'; readonly message: string; readonly updatedAt: number }

type UsageState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: ApiUsageData }
  | { readonly status: 'error'; readonly message: string }

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
function formatTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1_000) return String(n)
  if (abs < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Cost in CNY with precision that fits the magnitude. */
function formatCost(cost: number): string {
  return cost >= 1 ? `¥${cost.toFixed(2)}` : `¥${cost.toFixed(4)}`
}

/**
 * Render the Session Header balance capsule and its expandable overview panel.
 * @param props - session runtime, token-usage projection, and Remote-backed operations.
 * @returns the persistent header utility and its dropdown panel.
 */
export function ApiBalanceBadge({
  sessionId,
  useProjection,
  getBalance,
  getSessionUsage,
}: ApiBalanceBadgeProps): ReactNode {
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [usage, setUsage] = useState<UsageState>({ status: 'idle' })
  const [open, setOpen] = useState(false)
  const projection = useProjection('tokenUsage')

  const loadBalance = useCallback(async () => {
    try {
      const result = await getBalance()
      if (result.status === 'ok') {
        setView({ status: 'ready', data: result.data, updatedAt: Date.now() })
      } else {
        setView({ status: 'error', message: result.message, updatedAt: Date.now() })
      }
    } catch (error) {
      setView({ status: 'error', message: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
    }
  }, [getBalance])

  const loadUsage = useCallback(() => {
    setUsage(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void getSessionUsage(String(sessionId))
      .then((result) => {
        if (result.status === 'ok') setUsage({ status: 'ready', data: result.data })
        else setUsage({ status: 'error', message: result.message })
      })
      .catch((error: unknown) => {
        setUsage({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [getSessionUsage, sessionId])

  useEffect(() => {
    void loadBalance()
  }, [loadBalance])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && usage.status === 'idle') loadUsage()
  }
  const refresh = (): void => {
    void loadBalance()
    loadUsage()
  }

  let label = '查询中…'
  let tone = 'neutral'
  let chip: ReactNode = null
  let balanceRows: ReactNode[] = []
  if (view.status === 'ready') {
    const first = view.data.balances[0]
    label = first !== undefined ? `${first.currency} ${first.total}` : '余额 0'
    tone = view.data.isAvailable ? 'ok' : 'warn'
    chip = (
      <span className={`${css.chip} ${view.data.isAvailable ? css.chipOk : css.chipWarn}`}>
        {view.data.isAvailable ? '可用' : '不可用'}
      </span>
    )
    balanceRows = view.data.balances.map(balance => (
      <div key={`bal-${balance.currency}`} className={css.currencyGroup}>
        <div className={css.currency}>{balance.currency}</div>
        <div className={css.row}><span>剩余金额</span><b>{balance.total}</b></div>
      </div>
    ))
  } else if (view.status === 'error') {
    label = '余额不可用'
    tone = 'err'
    chip = <span className={`${css.chip} ${css.chipErr}`}>错误</span>
  }

  let usageBody: ReactNode
  if (usage.status === 'loading') {
    usageBody = <div className={css.loading}>计算中…</div>
  } else if (usage.status === 'error') {
    usageBody = <div className={css.errorText}>{usage.message}</div>
  } else if (usage.status === 'ready') {
    const data = usage.data
    const hasTokens = projection !== undefined
      && (projection.uncachedInputTokens > 0 || projection.outputTokens > 0
        || projection.cacheReadTokens > 0 || projection.cacheWriteTokens > 0)
    const hasCost = data.totalCost > 0 || data.models.some(model => model.cost > 0)
    if (!hasTokens && !hasCost) {
      usageBody = <div className={css.note}>本会话暂无模型用量</div>
    } else {
      const rows: ReactNode[] = []
      if (projection !== undefined && hasTokens) {
        const input = projection.uncachedInputTokens + projection.cacheReadTokens + projection.cacheWriteTokens
        const cacheHit = input > 0 ? Math.round(projection.cacheReadTokens / input * 100) : null
        rows.push(
          <div key="u-tok" className={css.usageTokens}>
            <span>{`Tokens · 输入 ${formatTokens(input)} · 输出 ${formatTokens(projection.outputTokens)}`}</span>
            <b>{cacheHit === null ? '' : `缓存 ${cacheHit}%`}</b>
          </div>,
        )
      }
      rows.push(
        <div key="u-cost" className={css.cost}>
          <span>{`估算费用${data.allPriced ? '' : '（部分未收录）'}`}</span>
          <b className={css.amount}>{formatCost(data.totalCost)}</b>
        </div>,
      )
      if (data.models.length > 1) {
        data.models.forEach(model => rows.push(
          <div key={`u-m-${model.model}`} className={css.model}>
            <span>{model.model}</span>
            <b>{model.priced ? formatCost(model.cost) : '—'}</b>
          </div>,
        ))
      }
      rows.push((
        <div key="u-note" className={css.note}>
          {data.ratesSource === 'live'
            ? '按官方实时价目估算（峰谷分时），实际以账单为准'
            : '按内置价目估算（官方价目获取失败），实际以账单为准'}
        </div>
      ))
      usageBody = <>{rows}</>
    }
  } else {
    // idle and loading both mean the section is not available yet.
    usageBody = <div className={css.loading}>计算中…</div>
  }

  const panel = open ? (
    <div className={css.panel}>
      <div className={css.head}>
        <span>API 概览</span>
        {chip ?? <span />}
      </div>
      {view.status === 'loading'
        ? <div className={css.loading}>查询中…</div>
        : view.status === 'error'
          ? <div className={css.errorText}>{view.message}</div>
          : (
            <>
              <div className={css.section}>账户余额</div>
              {balanceRows}
            </>
          )}
      <div className={css.sep} />
      <div className={css.section}>本会话用量</div>
      {usageBody}
      <div className={css.sep} />
      <div className={css.foot}>
        <span>{`更新于 ${view.status === 'loading' ? '—' : new Date(view.updatedAt).toLocaleTimeString()}`}</span>
        <button type="button" className={css.refresh} onClick={refresh}>刷新</button>
      </div>
    </div>
  ) : null

  return (
    <div className={css.wrap}>
      <button
        type="button"
        className={`${css.badge}${tone === 'neutral' ? '' : ` ${css[tone]}`}`}
        title="点击查看余额与本会话用量"
        onClick={toggle}
      >
        <span className={css.dot} />
        <span className={css.badgeLabel}>{label}</span>
      </button>
      {panel}
    </div>
  )
}
