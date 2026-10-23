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
import { and, eq, isNull, ne, type SQL } from 'drizzle-orm'
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
  approvers: string[]
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

const MAX_HELD_INPUT_BYTES = 64 * 1024

export type ApprovalLedger = {
  request(tx: Tx, input: ApprovalRequest): { approvalId: string }
  decide(input: { id: string; decision: ApprovalDecision; by: Caller }): Promise<DecideResult>
  list(filter: 'pending' | 'decided'): ApprovalView[]
  show(id: string): ApprovalView
  guard: Guard
  start(): Promise<void>
}

type Row = typeof pendingApproval.$inferSelect

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

function summary(view: ApprovalView): string {
  if (view.status === 'pending') return 'pending'
  const decided = `${view.status} by ${view.decidedBy} at ${view.decidedAt.toISOString()}`
  return view.handlerError === null
    ? decided
    : `${decided}, but its handler failed: ${view.handlerError}`
}

function escapeInvisible(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
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

function procedureRow(
  reader: Db | Tx,
  where: SQL | undefined,
  payload: ProcedurePayload,
): Row | undefined {
  return reader
    .select()
    .from(pendingApproval)
    .where(and(where, eq(pendingApproval.kind, 'procedure'), eq(pendingApproval.payload, payload)))
    .get()
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
}: {
  db: Db
  accessLedger: AccessLedger
  handlers: () => ApprovalHandlers
  /** Where the host mounts `router.decide`; a human named as approver may call only this path. */
  decidePath: readonly string[]
}): ApprovalLedger {
  const rowOf = (id: string): Row | undefined =>
    db.select().from(pendingApproval).where(eq(pendingApproval.id, id)).get()

  const show = (id: string): ApprovalView => {
    const row = rowOf(id)
    if (row === undefined)
      throw new ORPCError('NOT_FOUND', { message: `approval not found: ${id}` })
    return approvalView.parse(row)
  }

  const settle = async (row: Row, decision: ApprovalDecision): Promise<void> => {
    const handlerError = await dispatch(handlers(), recordOf(row), decision).then(
      () => null,
      (error: unknown) => escapeInvisible(error instanceof Error ? error.message : String(error)),
    )
    transaction(db, (tx) => {
      tx.update(pendingApproval)
        .set({ handledAt: new Date(), handlerError })
        .where(and(eq(pendingApproval.id, row.id), isNull(pendingApproval.handledAt)))
        .run()
    })
  }

  const grantFact = ({ grant, path, input, caller }: GuardCall): GrantFact => {
    if (grant === null) return 'none'
    const granted = procedureRow(
      db,
      and(
        eq(pendingApproval.id, grant.approvalId),
        eq(pendingApproval.status, 'approved'),
        isNull(pendingApproval.handledAt),
      ),
      { path: [...path], input, caller },
    )
    return granted === undefined ? 'invalid' : 'valid'
  }

  const callerIsApprover = ({ caller, path, input }: GuardCall): boolean => {
    const target = decideTarget.safeParse(input)
    if (caller.kind !== 'human' || !samePath(path, decidePath) || !target.success) return false
    const row = rowOf(target.data[0])
    return row !== undefined && accessLedger.isApprover(caller, row.approvers)
  }

  const request: ApprovalLedger['request'] = (tx, input) => {
    const approvalId = `apr-${Bun.randomUUIDv7()}`
    tx.insert(pendingApproval)
      .values({
        ...input,
        id: approvalId,
        body: input.body.map(escapeInvisible),
        approvers: accessLedger.approverChain(input.agentGroupId),
        status: 'pending',
        createdAt: new Date(),
      })
      .run()
    return { approvalId }
  }

  const hold = (caller: AgentCaller, { path, input }: GuardCall): { approvalId: string } => {
    const bytes = Buffer.byteLength(JSON.stringify(input) ?? '')
    if (bytes > MAX_HELD_INPUT_BYTES) {
      throw new ORPCError('PAYLOAD_TOO_LARGE', {
        message: `a held call's input may be at most ${MAX_HELD_INPUT_BYTES} bytes; this one is ${bytes}`,
      })
    }
    const title = path.join('.')
    const payload = { path: [...path], input, caller }
    return transaction(db, (tx) => {
      const pending = procedureRow(tx, eq(pendingApproval.status, 'pending'), payload)
      if (pending !== undefined) return { approvalId: pending.id }
      return request(tx, {
        kind: 'procedure',
        agentGroupId: caller.agentGroupId,
        sessionId: caller.sessionId,
        title,
        body: holdBody(caller, title, input),
        payload,
      })
    })
  }

  return {
    request,
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
            message: `${principal ?? 'this caller'} is not an approver of ${id}`,
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
      await settle(transition.row, decision)
      const approval = show(id)
      return { changed: true, message: summary(approval), approval }
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
          return { kind: 'hold', request: () => hold(result.caller, call) }
      }
    },
    async start() {
      const unhandled = db
        .select()
        .from(pendingApproval)
        .where(and(ne(pendingApproval.status, 'pending'), isNull(pendingApproval.handledAt)))
        .orderBy(pendingApproval.createdAt, pendingApproval.id)
        .all()
      for (const row of unhandled) {
        if (row.status !== 'pending') await settle(row, decisionOf[row.status])
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
