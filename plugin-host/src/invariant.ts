/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-balance/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-balance'

/** Cordis companion plugin name. */
export const name = 'api-balance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gateway recomputes balance and per-session usage
 * per call from credentials/shell/sessionQuery and owns no durable state; its
 * usage fold replays session-owned events without maintaining a cross-package
 * relationship of its own.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
