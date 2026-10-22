// @kurumi/rpc/server — no domain. Bun only. The context every handler gets, and the guard middleware the host
// puts in front of the whole composed router (`guardRouter`). Domains implement their contracts with
// `implement(contract).$context<KurumiContext & { <d>Ledger }>()` and never touch the guard.
import { ORPCError, os } from '@orpc/server'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { Caller, Meta } from './contract.ts'

export type Db = BunSQLiteDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** A live approved row for exactly this call (approval replay). Satisfies a hold, never a deny; usable once. */
export type ApprovalGrant = { approvalId: string }

export type GuardCall = {
  path: readonly string[]
  meta: Meta
  caller: Caller
  input: unknown
  grant: ApprovalGrant | null
}

export type GuardOutcome = { kind: 'allow' } | { kind: 'held'; approvalId: string } | { kind: 'deny'; reason: string }

/** Implemented by the approval domain (it owns holds); reaches handlers through the context the host builds. */
export type Guard = (call: GuardCall) => GuardOutcome

/** What every handler's context starts with. Domains add their own Ledger on top. */
export type KurumiContext = { db: Db; caller: Caller; guard: Guard; grant: ApprovalGrant | null }

const base = os.$context<KurumiContext>().$meta<Meta>({})

/**
 * Runs before every handler. The agent-without-meta refusal is here, not in the approval domain, so it holds
 * even if the injected guard is wrong.
 */
export const guarded = base.middleware(async ({ context, path, procedure, next }, input) => {
  const meta = procedure['~orpc'].meta
  if (context.caller.kind === 'agent' && meta.agent === undefined) {
    throw new ORPCError('FORBIDDEN', { message: `agents may not call ${path.join('.')}` })
  }
  const outcome = context.guard({ path, meta, caller: context.caller, input, grant: context.grant })
  switch (outcome.kind) {
    case 'allow':
      return next()
    case 'held':
      throw new ORPCError('APPROVAL_PENDING', { status: 202, data: { approvalId: outcome.approvalId } })
    case 'deny':
      throw new ORPCError('FORBIDDEN', { message: outcome.reason })
  }
})

/**
 * The host's composition step: every procedure of the composed router gets `guarded` in front of it
 * (oRPC applies a builder's middlewares to each procedure of a router passed to `.router`). Domains never
 * apply or call the guard themselves; there is no second, unguarded router to mount.
 */
export function guardRouter<TContext extends KurumiContext>() {
  return os.$context<TContext>().$meta<Meta>({}).use(guarded)
}

/** The group a call acts on: an agent's own group, or the one a host/human named. */
export function targetGroup(caller: Caller, requested: string | undefined): string {
  if (caller.kind === 'agent') return caller.agentGroupId
  if (requested === undefined) throw new ORPCError('BAD_REQUEST', { message: 'agentGroupId is required' })
  return requested
}
