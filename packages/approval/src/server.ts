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
import { and, eq, isNull, ne } from 'drizzle-orm'
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

/** Runs after the decision commits, and again at the next start if it did not finish, so it must be idempotent. */
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

export type HandlerFailure = { approvalId: string; error: unknown }

export type ApprovalLedger = {
  request(tx: Tx, input: ApprovalRequest): { approvalId: string }
  decide(input: { id: string; decision: ApprovalDecision; by: Caller }): Promise<DecideResult>
  list(filter: 'pending' | 'decided'): ApprovalView[]
  show(id: string): ApprovalView
  guard: Guard
  /** Re-runs, oldest first, the handler of every decided approval whose handler never finished. */
  start(): Promise<HandlerFailure[]>
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
  return view.status === 'pending'
    ? 'pending'
    : `${view.status} by ${view.decidedBy} at ${view.decidedAt.toISOString()}`
}

function holdBody(caller: AgentCaller, title: string, input: unknown): string[] {
  return [
    `Agent group ${caller.agentGroupId} (session ${caller.sessionId}) asks to run ${title}.`,
    `Input: ${JSON.stringify(input ?? null)}`,
  ]
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
}: {
  db: Db
  accessLedger: AccessLedger
  /** Late-bound: the handlers live above this domain, in the host. */
  handlers: () => ApprovalHandlers
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
    await dispatch(handlers(), recordOf(row), decision)
    transaction(db, (tx) => {
      tx.update(pendingApproval)
        .set({ handledAt: new Date() })
        .where(and(eq(pendingApproval.id, row.id), isNull(pendingApproval.handledAt)))
        .run()
    })
  }

  const grantFact = ({ grant, path }: GuardCall): GrantFact => {
    if (grant === null) return 'none'
    const row = rowOf(grant.approvalId)
    if (row?.kind !== 'procedure' || row.status !== 'approved' || row.handledAt !== null) {
      return 'invalid'
    }
    const payload = procedurePayload.safeParse(row.payload)
    return payload.success &&
      payload.data.path.length === path.length &&
      payload.data.path.every((segment, index) => segment === path[index])
      ? 'valid'
      : 'invalid'
  }

  const request: ApprovalLedger['request'] = (tx, input) => {
    const approvalId = `apr-${Bun.randomUUIDv7()}`
    tx.insert(pendingApproval)
      .values({
        ...input,
        id: approvalId,
        approvers: accessLedger.approverChain(input.agentGroupId),
        status: 'pending',
        createdAt: new Date(),
      })
      .run()
    return { approvalId }
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
      try {
        await settle(transition.row, decision)
      } catch (error) {
        const approval = show(id)
        const reason = error instanceof Error ? error.message : String(error)
        return {
          changed: true,
          message: `${summary(approval)}, but its handler failed and runs again at the next host start: ${reason}`,
          approval,
        }
      }
      const approval = show(id)
      return { changed: true, message: summary(approval), approval }
    },
    guard(call) {
      const result = verdict(call, {
        callerIsOwner: accessLedger.isOwner(call.caller),
        grant: grantFact(call),
      })
      switch (result.kind) {
        case 'allow':
        case 'deny':
          return result
        case 'hold': {
          const { caller } = result
          const title = call.path.join('.')
          return {
            kind: 'held',
            approvalId: transaction(
              db,
              (tx) =>
                request(tx, {
                  kind: 'procedure',
                  agentGroupId: caller.agentGroupId,
                  sessionId: caller.sessionId,
                  title,
                  body: holdBody(caller, title, call.input),
                  payload: { path: [...call.path], input: call.input, caller },
                }).approvalId,
            ),
          }
        }
      }
    },
    async start() {
      const unhandled = db
        .select()
        .from(pendingApproval)
        .where(and(ne(pendingApproval.status, 'pending'), isNull(pendingApproval.handledAt)))
        .orderBy(pendingApproval.createdAt, pendingApproval.id)
        .all()
      const failures: HandlerFailure[] = []
      for (const row of unhandled) {
        if (row.status === 'pending') continue
        try {
          await settle(row, decisionOf[row.status])
        } catch (error) {
          failures.push({ approvalId: row.id, error })
        }
      }
      return failures
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
