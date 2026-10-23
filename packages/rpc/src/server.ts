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
  | { kind: 'held'; approvalId: string }
  | { kind: 'deny'; reason: string }
export type Guard = (call: GuardCall) => GuardOutcome
export type KurumiContext = { db: Db; caller: Caller; guard: Guard; grant: ApprovalGrant | null }

export type GrantFact = 'none' | 'valid' | 'invalid'
export type VerdictFacts = { callerIsOwner: boolean; grant: GrantFact }
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'hold'; caller: AgentCaller }
  | { kind: 'deny'; reason: string }

const allow: Verdict = { kind: 'allow' }

export function verdict(call: Omit<GuardCall, 'grant'>, facts: VerdictFacts): Verdict {
  const { caller, meta, path } = call
  const name = path.join('.')
  switch (caller.kind) {
    case 'host':
      return allow
    case 'human':
      return facts.callerIsOwner
        ? allow
        : { kind: 'deny', reason: `only the owner may call ${name}` }
    case 'agent':
      break
    default: {
      const _exhaustive: never = caller
      return _exhaustive
    }
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

async function validInput(procedure: AnyProcedure, input: unknown): Promise<unknown> {
  const schema = procedure['~orpc'].inputSchema
  if (schema === undefined) return input
  const result = await schema['~standard'].validate(input)
  if (result.issues) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'Input validation failed',
      data: { issues: result.issues },
    })
  }
  return result.value
}

const base = os.$context<KurumiContext>().$meta<Meta>({})

export const guarded = base.middleware(async ({ context, path, procedure, next }, input) => {
  const meta = procedure['~orpc'].meta
  if (context.caller.kind === 'agent' && meta.agent === undefined) {
    throw new ORPCError('FORBIDDEN', { message: `agents may not call ${path.join('.')}` })
  }
  // oRPC runs router-level middleware before input validation, so a malformed call must not reach the guard.
  const valid = await validInput(procedure, input)
  const outcome = context.guard({
    path,
    meta,
    caller: context.caller,
    input: valid,
    grant: context.grant,
  })
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

/** Calls the procedure at `path` through every middleware the router put in front of it. */
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
