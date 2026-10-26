import { createHash } from 'node:crypto'

import type { Principal } from '@kurumi/access/contract'
import type { AccessLedger } from '@kurumi/access/server'
import type { AgentCaller, Caller } from '@kurumi/rpc/contract'
import {
  transaction,
  verdict,
  type Db,
  type GrantFact,
  type Guard,
  type GuardCall,
  type KurumiContext,
  type Tx,
} from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { and, count, eq, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'

import {
  approvalView,
  contract,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalView,
} from './contract.ts'
import { pendingApproval } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export type { ApprovalDecision, ApprovalKind, ApprovalView }

const callerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }),
  z.object({ kind: z.literal('human'), userId: z.string() }),
  z.object({ kind: z.literal('agent'), agentGroupId: z.string(), sessionId: z.string() }),
]) satisfies z.ZodType<Caller>

const procedurePayload = z.object({
  path: z.array(z.string()),
  input: z.unknown(),
  caller: callerSchema,
})
export type ProcedurePayload = z.infer<typeof procedurePayload>

type ApprovalPayloads = { procedure: ProcedurePayload; 'gateway.request': unknown }

type ApprovalFields = {
  id: string
  agentGroupId: string | null
  sessionId: string | null
  title: string
  body: string[]
  approvers: Principal[]
  createdAt: Date
}

export type ApprovalRecord<K extends ApprovalKind = ApprovalKind> = K extends ApprovalKind
  ? ApprovalFields & { kind: K; payload: ApprovalPayloads[K] }
  : never

/** Runs after the decision commits, and again at the next start if the host died before it finished. */
export type ApprovalDecisionHandler<K extends ApprovalKind = ApprovalKind> = (
  approval: ApprovalRecord<K>,
  decision: ApprovalDecision,
) => Promise<void>

export type ApprovalHandlers = { [K in ApprovalKind]: ApprovalDecisionHandler<K> }

export type ApprovalRequest = {
  [K in ApprovalKind]: {
    kind: K
    agentGroupId: string | null
    sessionId: string | null
    title: string
    body: string[]
    payload: ApprovalPayloads[K]
  }
}[ApprovalKind]

export type DecideResult = { changed: boolean; message: string; approval: ApprovalView }

export type ApprovalLog = {
  kind: 'approval.handler.failed' | 'approval.outcome.unrecorded'
  approvalId: string
  error: string
}

const MAX_HELD_INPUT_BYTES = 64 * 1024
const MAX_HELD_PER_AGENT_GROUP = 20

export type ApprovalLedger = {
  request(tx: Tx, input: ApprovalRequest): { approvalId: string }
  decide(input: { id: string; decision: ApprovalDecision; by: Caller }): Promise<DecideResult>
  list(filter: 'pending' | 'decided'): ApprovalView[]
  show(id: string): ApprovalView
  guard: Guard
  start(): Promise<void>
}

type Row = typeof pendingApproval.$inferSelect
type Settled = { recorded: true } | { recorded: false; reason: string }

const decisionOf = { approved: 'approve', denied: 'deny' } as const

function recordOf(row: Row): ApprovalRecord {
  const fields: ApprovalFields = {
    id: row.id,
    agentGroupId: row.agentGroupId,
    sessionId: row.sessionId,
    title: row.title,
    body: row.body,
    approvers: row.approvers,
    createdAt: row.createdAt,
  }
  switch (row.kind) {
    case 'procedure':
      return { ...fields, kind: row.kind, payload: procedurePayload.parse(row.payload) }
    case 'gateway.request':
      return { ...fields, kind: row.kind, payload: row.payload }
  }
}

function nameOf(principal: Principal): string {
  return principal.kind === 'host' ? 'host' : `user ${escapeInvisible(principal.userId)}`
}

function summary(view: ApprovalView): string {
  if (view.status === 'pending') return 'pending'
  const decided = `${view.status} by ${nameOf(view.decidedBy)} at ${view.decidedAt.toISOString()}`
  return view.handlerError === null
    ? decided
    : `${decided}, but its handler failed: ${view.handlerError}`
}

function escapeInvisible(text: string): string {
  return text.replace(
    /(?!\u0020)[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800\ufffc]/gu,
    (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
  )
}

function errorText(error: unknown): string {
  try {
    return escapeInvisible(String(error instanceof Error ? error.message : error))
  } catch {
    return 'an error with no text'
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    typeof field === 'object' && field !== null && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : field,
  )
}

function holdBody(caller: AgentCaller, title: string, input: unknown): string[] {
  return [
    `Agent group ${caller.agentGroupId} (session ${caller.sessionId}) asks to run ${title}.`,
    `Input: ${JSON.stringify(input ?? null)}`,
  ]
}

const decideTarget = z.tuple([z.string()]).rest(z.unknown())

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index])
}

function dispatch(
  handlers: ApprovalHandlers,
  record: ApprovalRecord,
  decision: ApprovalDecision,
): Promise<void> {
  switch (record.kind) {
    case 'procedure':
      return handlers.procedure(record, decision)
    case 'gateway.request':
      return handlers['gateway.request'](record, decision)
  }
}

export function createApprovalLedger({
  db,
  accessLedger,
  handlers,
  decidePath,
  log,
}: {
  db: Db
  accessLedger: AccessLedger
  handlers: () => ApprovalHandlers
  /** Where the host mounts `router.decide`; a human named as approver may call only this path. */
  decidePath: readonly string[]
  log: (event: ApprovalLog) => void
}): ApprovalLedger {
  const rowOf = (id: string): Row | undefined =>
    db.select().from(pendingApproval).where(eq(pendingApproval.id, id)).get()

  const show = (id: string): ApprovalView => {
    const row = rowOf(id)
    if (row === undefined)
      throw new ORPCError('NOT_FOUND', { message: `approval not found: ${id}` })
    return approvalView.parse(row)
  }

  const settle = async (
    id: string,
    decision: ApprovalDecision,
    load: () => ApprovalRecord,
  ): Promise<Settled> => {
    const handlerError = await (async () => dispatch(handlers(), load(), decision))().then(
      () => null,
      errorText,
    )
    if (handlerError !== null) {
      log({ kind: 'approval.handler.failed', approvalId: id, error: handlerError })
    }
    try {
      db.update(pendingApproval)
        .set({ handledAt: new Date(), handlerError })
        .where(and(eq(pendingApproval.id, id), isNull(pendingApproval.handledAt)))
        .run()
      return { recorded: true }
    } catch (error) {
      const reason = errorText(error)
      log({ kind: 'approval.outcome.unrecorded', approvalId: id, error: reason })
      return { recorded: false, reason }
    }
  }

  const grantFact = ({ grant, path, input, caller }: GuardCall): GrantFact => {
    if (grant === null) return 'none'
    const payload: ProcedurePayload = { path: [...path], input, caller }
    const granted = db
      .select({ id: pendingApproval.id })
      .from(pendingApproval)
      .where(
        and(
          eq(pendingApproval.id, grant.approvalId),
          eq(pendingApproval.kind, 'procedure'),
          eq(pendingApproval.status, 'approved'),
          isNull(pendingApproval.handledAt),
          eq(pendingApproval.payload, payload),
        ),
      )
      .get()
    return granted === undefined ? 'invalid' : 'valid'
  }

  const callerIsApprover = ({ caller, path, input }: GuardCall): boolean => {
    const target = decideTarget.safeParse(input)
    if (caller.kind !== 'human' || !samePath(path, decidePath) || !target.success) return false
    const row = rowOf(target.data[0])
    return row !== undefined && accessLedger.isApprover(caller, row.approvers)
  }

  const insert = (
    tx: Tx,
    input: ApprovalRequest,
    dedupeKey: string | null,
  ): { approvalId: string } => {
    const approvalId = `apr-${Bun.randomUUIDv7()}`
    tx.insert(pendingApproval)
      .values({
        ...input,
        id: approvalId,
        title: escapeInvisible(input.title),
        body: input.body.map(escapeInvisible),
        dedupeKey,
        approvers: accessLedger.approverChain(input.agentGroupId),
        status: 'pending',
        createdAt: new Date(),
      })
      .run()
    return { approvalId }
  }

  const hold = (
    caller: AgentCaller,
    { path, input }: GuardCall,
    validInput: unknown,
  ): { approvalId: string } => {
    const bytes = Buffer.byteLength(JSON.stringify(input) ?? '')
    if (bytes > MAX_HELD_INPUT_BYTES) {
      throw new ORPCError('PAYLOAD_TOO_LARGE', {
        message: `a held call's input may be at most ${MAX_HELD_INPUT_BYTES} bytes; this one is ${bytes}`,
      })
    }
    const title = path.join('.')
    const dedupeKey = createHash('sha256')
      .update(canonicalJson({ path, caller, input: validInput }))
      .digest('hex')
    return transaction(db, (tx) => {
      const pending = tx
        .select({ id: pendingApproval.id })
        .from(pendingApproval)
        .where(and(eq(pendingApproval.dedupeKey, dedupeKey), eq(pendingApproval.status, 'pending')))
        .get()
      if (pending !== undefined) return { approvalId: pending.id }
      const open = tx
        .select({ held: count() })
        .from(pendingApproval)
        .where(
          and(
            eq(pendingApproval.agentGroupId, caller.agentGroupId),
            eq(pendingApproval.status, 'pending'),
            eq(pendingApproval.kind, 'procedure'),
          ),
        )
        .get()
      if ((open?.held ?? 0) >= MAX_HELD_PER_AGENT_GROUP) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: `agent group ${caller.agentGroupId} already waits on ${MAX_HELD_PER_AGENT_GROUP} held calls`,
        })
      }
      return insert(
        tx,
        {
          kind: 'procedure',
          agentGroupId: caller.agentGroupId,
          sessionId: caller.sessionId,
          title,
          body: holdBody(caller, title, input),
          payload: { path: [...path], input, caller },
        },
        dedupeKey,
      )
    })
  }

  return {
    request: (tx, input) => insert(tx, input, null),
    show,
    list(filter) {
      return db
        .select()
        .from(pendingApproval)
        .where(
          filter === 'pending'
            ? eq(pendingApproval.status, 'pending')
            : ne(pendingApproval.status, 'pending'),
        )
        .orderBy(pendingApproval.createdAt, pendingApproval.id)
        .all()
        .map((row) => approvalView.parse(row))
    },
    async decide({ id, decision, by }) {
      const transition = transaction(db, (tx) => {
        const row = tx.select().from(pendingApproval).where(eq(pendingApproval.id, id)).get()
        if (row === undefined) {
          throw new ORPCError('NOT_FOUND', { message: `approval not found: ${id}` })
        }
        const principal = accessLedger.principalOf(by)
        if (principal === null || !accessLedger.isApprover(by, row.approvers)) {
          throw new ORPCError('FORBIDDEN', {
            message: `${principal === null ? 'this caller' : nameOf(principal)} is not an approver of ${id}`,
          })
        }
        const decided = tx
          .update(pendingApproval)
          .set({
            status: decision === 'approve' ? 'approved' : 'denied',
            decidedBy: principal,
            decidedAt: new Date(),
          })
          .where(and(eq(pendingApproval.id, id), eq(pendingApproval.status, 'pending')))
          .returning()
          .get()
        return decided === undefined ? { changed: false, row } : { changed: true, row: decided }
      })
      if (!transition.changed) {
        const approval = approvalView.parse(transition.row)
        return { changed: false, message: `already ${summary(approval)}`, approval }
      }
      const { row } = transition
      const settled = await settle(id, decision, () => recordOf(row))
      const approval = show(id)
      const message = settled.recorded
        ? summary(approval)
        : `${summary(approval)}, but recording its outcome failed, so its handler runs again at the next host start: ${settled.reason}`
      return { changed: true, message, approval }
    },
    guard(call) {
      const result = verdict(call, {
        callerIsOwner: accessLedger.isOwner(call.caller),
        callerIsApprover: callerIsApprover(call),
        grant: grantFact(call),
      })
      switch (result.kind) {
        case 'allow':
        case 'deny':
          return result
        case 'hold':
          return {
            kind: 'hold',
            request: (validInput) => hold(result.caller, call, validInput),
          }
      }
    },
    async start() {
      const unhandled = db
        .select({ id: pendingApproval.id, status: pendingApproval.status })
        .from(pendingApproval)
        .where(and(ne(pendingApproval.status, 'pending'), isNull(pendingApproval.handledAt)))
        .orderBy(pendingApproval.createdAt, pendingApproval.id)
        .all()
      for (const { id, status } of unhandled) {
        if (status === 'pending') continue
        await settle(id, decisionOf[status], () => {
          const row = rowOf(id)
          if (row === undefined) throw new Error(`approval ${id} vanished before its handler ran`)
          return recordOf(row)
        })
      }
    },
  }
}

const os = implement(contract).$context<KurumiContext & { approvalLedger: ApprovalLedger }>()

export const router = os.router({
  list: os.list.handler(({ context, input }) => context.approvalLedger.list(input.status)),
  show: os.show.handler(({ context, input: [id] }) => context.approvalLedger.show(id)),
  decide: os.decide.handler(({ context, input: [id, flags] }) =>
    context.approvalLedger.decide({
      id,
      decision: flags.approve === true ? 'approve' : 'deny',
      by: context.caller,
    }),
  ),
})
