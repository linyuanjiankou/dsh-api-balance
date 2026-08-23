/** Browser plugin mounting the DeepSeek API balance badge into the Session Header. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ApiBalanceData, ApiGatewayResult, ApiUsageData } from '@deepseek-ai/dsh-api-remotes/client'
import { ApiBalanceBadge, type ApiBalanceBadgeInjected } from './BalanceBadge.tsx'

export type { ApiBalanceBadgeInjected, ApiBalanceBadgeProps } from './BalanceBadge.tsx'

/** Services required by the Session Header registration and the generated Remote face. */
export const inject = ['slots', 'remote', 'remote.apiBalance']

/** Contribute the persistent balance badge to the Session Header utility row. */
export function apply(ctx: ClientContext): void {
  const injected = (): ApiBalanceBadgeInjected => ({
    getBalance: async (): Promise<ApiGatewayResult<ApiBalanceData>> => {
      const result = await ctx.remote.apiBalance.getBalance()
      return result.ok ? result.value : { status: 'error', message: result.error.message }
    },
    getSessionUsage: async (sessionId: string): Promise<ApiGatewayResult<ApiUsageData>> => {
      const result = await ctx.remote.apiBalance.getSessionUsage(sessionId)
      return result.ok ? result.value : { status: 'error', message: result.error.message }
    },
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'api-balance-badge',
    order: 5,
    inject: injected,
  }, ApiBalanceBadge))
}
