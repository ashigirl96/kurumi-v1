import type { AnyContractRouter } from '@orpc/contract'
import {
  call as callProcedure,
  getRouter,
  isProcedure,
  ORPCError,
  os,
  unlazy,
  type AnyProcedure,
  type Router,
} from '@orpc/server'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { AgentCaller, Caller, Meta } from './contract.ts'

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
  | { kind: 'hold'; request: () => { approvalId: string } }
  | { kind: 'deny'; reason: string }
export type Guard = (call: GuardCall) => GuardOutcome
export type KurumiContext = { db: Db; caller: Caller; guard: Guard; grant: ApprovalGrant | null }

export type GrantFact = 'none' | 'valid' | 'invalid'
export type VerdictFacts = {
  callerIsOwner: boolean
  /** The caller is a baked approver of the approval this call decides. */
  callerIsApprover: boolean
  grant: GrantFact
}
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'hold'; caller: AgentCaller }
  | { kind: 'deny'; reason: string }

const allow: Verdict = { kind: 'allow' }

export function verdict(call: Omit<GuardCall, 'grant'>, facts: VerdictFacts): Verdict {
  const { caller, meta, path } = call
  const name = path.join('.')
  if (caller.kind === 'host') return allow
  if (caller.kind === 'human') {
    return facts.callerIsOwner || facts.callerIsApprover
      ? allow
      : { kind: 'deny', reason: `only the owner may call ${name}` }
  }
  switch (meta.agent) {
    case undefined:
      return { kind: 'deny', reason: `agents may not call ${name}` }
    case 'channel':
      return allow
    case 'own-group': {
      const requested = requestedGroup(call.input)
      return requested === undefined || requested === caller.agentGroupId
        ? allow
        : { kind: 'deny', reason: `${name} is limited to the caller's own agent group` }
    }
    case 'scoped':
      return { kind: 'deny', reason: `${name} needs a CLI Scope, which agents do not have yet` }
    case 'hold':
      switch (facts.grant) {
        case 'none':
          return { kind: 'hold', caller }
        case 'valid':
          return allow
        case 'invalid':
          return { kind: 'deny', reason: `the approval grant does not cover ${name}` }
      }
  }
}

function requestedGroup(input: unknown): unknown {
  return typeof input === 'object' && input !== null && 'agentGroupId' in input
    ? input.agentGroupId
    : undefined
}

async function assertValidInput(procedure: AnyProcedure, input: unknown): Promise<void> {
  const result = await procedure['~orpc'].inputSchema?.['~standard'].validate(input)
  if (result?.issues) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'Input validation failed',
      data: { issues: result.issues },
    })
  }
}

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
    case 'hold':
      // oRPC validates input only after router-level middleware, so a malformed call must not become an approval.
      await assertValidInput(procedure, input)
      throw new ORPCError('APPROVAL_PENDING', {
        status: 409,
        data: { approvalId: outcome.request().approvalId },
      })
    case 'deny':
      throw new ORPCError('FORBIDDEN', { message: outcome.reason })
  }
})

export function guardRouter<TContext extends KurumiContext>() {
  return os.$context<TContext>().$meta<Meta>({}).use(guarded)
}

export async function callByPath<TContext extends KurumiContext>(
  router: Router<AnyContractRouter, TContext>,
  path: readonly string[],
  input: unknown,
  context: TContext,
): Promise<unknown> {
  const { default: target } = await unlazy(getRouter(router, path))
  if (!isProcedure(target)) {
    throw new ORPCError('NOT_FOUND', { message: `no procedure at ${path.join('.')}` })
  }
  return callProcedure(target, input, { context, path })
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
