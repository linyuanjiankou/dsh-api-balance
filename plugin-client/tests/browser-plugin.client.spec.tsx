// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ApiBalanceBadge, type ApiBalanceBadgeInjected } from '../src/client/BalanceBadge.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

type RemoteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  declare(slots)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const getBalance = vi.fn<() => Promise<RemoteResult>>()
    .mockResolvedValue({ ok: true, value: { status: 'ok', data: { balances: [] } } })
  const getSessionUsage = vi.fn<(sessionId: string) => Promise<RemoteResult>>()
    .mockResolvedValue({ ok: true, value: { status: 'ok', data: { models: [] } } })
  ctx.provide('remote.apiBalance', { getBalance, getSessionUsage })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber, getBalance, getSessionUsage }
}

describe('ui-api-balance browser plugin', () => {
  it('declares only the services used by the Session Header Remote contribution', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.apiBalance'])
  })

  it('registers the badge without reading the Remote eagerly and removes it on disposal', async () => {
    const b = await bench()
    expect(b.getBalance).not.toHaveBeenCalled()
    expect(b.getSessionUsage).not.toHaveBeenCalled()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(ApiBalanceBadge)
    expect(entry?.options).toMatchObject({ id: 'api-balance-badge', order: 5 })

    const injected = (entry?.inject as unknown as () => ApiBalanceBadgeInjected)()
    await expect(injected.getBalance()).resolves.toEqual({ status: 'ok', data: { balances: [] } })
    await expect(injected.getSessionUsage('s1')).resolves.toEqual({ status: 'ok', data: { models: [] } })
    expect(b.getBalance).toHaveBeenCalledOnce()
    expect(b.getSessionUsage).toHaveBeenCalledWith('s1')

    b.getBalance.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE', message: 'unavailable' } })
    await expect(injected.getBalance()).resolves.toEqual({ status: 'error', message: 'unavailable' })
    b.getSessionUsage.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE', message: 'log missing' } })
    await expect(injected.getSessionUsage('s1')).resolves.toEqual({ status: 'error', message: 'log missing' })

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })
})
