import { ORPCError, os } from '@orpc/server'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { Caller, Meta } from './contract.ts'

export type Db = BunSQLiteDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type ApprovalGrant = { approvalId: string }
export type GuardCall = {
  path: readonly string[]
  meta: Meta
  caller: Caller
  input: unknown
  grant: ApprovalGrant | null
}
export type GuardOutcome =
  | { kind: 'allow' }
  | { kind: 'held'; approvalId: string }
  | { kind: 'deny'; reason: string }
export type Guard = (call: GuardCall) => GuardOutcome
export type KurumiContext = { db: Db; caller: Caller; guard: Guard; grant: ApprovalGrant | null }

const base = os.$context<KurumiContext>().$meta<Meta>({})

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
      throw new ORPCError('APPROVAL_PENDING', {
        status: 409,
        data: { approvalId: outcome.approvalId },
      })
    case 'deny':
      throw new ORPCError('FORBIDDEN', { message: outcome.reason })
  }
})

export function guardRouter<TContext extends KurumiContext>() {
  return os.$context<TContext>().$meta<Meta>({}).use(guarded)
}

export function targetGroup(caller: Caller, requested: string | undefined): string {
  if (caller.kind === 'agent') return caller.agentGroupId
  if (requested === undefined)
    throw new ORPCError('BAD_REQUEST', { message: 'agentGroupId is required' })
  return requested
}

export function transaction(db: Db, callback: (tx: Tx) => undefined): undefined
export function transaction<T>(
  db: Db,
  callback: (tx: Tx) => T & (void extends T ? never : { then?: never } | null | undefined),
): T
export function transaction(db: Db, callback: (tx: Tx) => unknown): unknown {
  return db.transaction(callback)
}
