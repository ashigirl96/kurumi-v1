// @kurumi/approval/server
// Guard + approvals. The guard decision lives here (it owns holds); the middleware that applies it to every
// procedure lives in @kurumi/rpc/server and is put in front of the composed router by the host.
import type { AccessLedger } from '@kurumi/access/server'
import type { AgentLedger } from '@kurumi/agent/server'
import type { CardAction, CardActionReply, ChatLedger } from '@kurumi/chat/server'
import type { SystemJob } from '@kurumi/job/server'
import type { Caller, Meta } from '@kurumi/rpc/contract'
import type { Db, Guard, KurumiContext, Tx } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import type { ApprovalKind, ApprovalOrigin } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export type { ApprovalKind, ApprovalOrigin }

export type ApprovalRecord = {
  id: string
  kind: ApprovalKind
  origin: ApprovalOrigin
  payload: unknown
}

export type Decision = { kind: 'approve' } | { kind: 'reject'; reason: string | null } | { kind: 'expire' }

/** Called after the decision commits. Must be idempotent: a crash between commit and handler re-runs it on boot. */
export type ApprovalDecisionHandler = (approval: ApprovalRecord, decision: Decision) => Promise<void>

export type ApprovalHandlers = Record<ApprovalKind, ApprovalDecisionHandler>

/**
 * Where an approval card goes. The default is nanoclaw's behaviour: the first approver with a reachable DM
 * (Console Inbox for the owner), with the origin chat and session written in the body. Which policy to use is an
 * open question for the user, so it is one config value read by this one pure function.
 */
export type ApprovalCardPolicy =
  | 'approver-dm'
  | 'origin-if-owner-only' // in place when the origin chat is owner-only (Console), else DM
  | 'origin' // default (user decision): in place whenever there is an origin chat; clicks still checked against `approvers`

export type CardTarget =
  | { kind: 'origin'; messagingGroupId: string; threadId: string | null }
  | { kind: 'dm'; candidates: readonly string[] } // approvers in order; delivery takes the first reachable DM

export function cardTarget(
  policy: ApprovalCardPolicy,
  input: { origin: (ApprovalOrigin & { ownerOnly: boolean }) | null; approvers: readonly string[] },
): CardTarget {
  // TODO
  // const o = input.origin
  // if (o?.messagingGroupId && (policy === 'origin' || (policy === 'origin-if-owner-only' && o.ownerOnly)))
  //   return { kind: 'origin', messagingGroupId: o.messagingGroupId, threadId: o.threadId }
  // return { kind: 'dm', candidates: input.approvers }
  throw new Error('not implemented')
}

/** Pure guard verdict, given the facts the ledger looked up. */
export type Verdict = { kind: 'allow' } | { kind: 'hold'; title: string } | { kind: 'deny'; reason: string }

export function verdict(input: {
  meta: Meta
  path: readonly string[]
  caller: Caller
  input: unknown
  /** caller's group CLI Scope (agent callers only) */
  cliScope: 'disabled' | 'group' | 'global' | null
  callerIsOwner: boolean
  callerIsAdminOfTarget: boolean
  hasGrant: boolean
}): Verdict {
  // TODO
  // host → allow
  // human → owner ? allow : meta.humanHold ? (hasGrant ? allow : hold) : callerIsAdminOfTarget ? allow : deny
  // agent (meta.agent is defined — rpc's middleware refused the rest):
  //   'channel' → allow (handler scopes to caller.sessionId)
  //   'own-group' → input.agentGroupId absent or === caller's ? allow : deny
  //   'scoped' → disabled → deny; group → target ≠ own ? (hasGrant ? allow : hold) : allow; global → allow
  //   'hold' → hasGrant ? allow : hold
  throw new Error('not implemented')
}

export type ApprovalLedger = {
  start(): Promise<void>
  stop(): void
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }

  /**
   * Sync, in the caller's transaction: resolve and bake `approvers`, insert the row. The card is delivered after
   * commit to `cardTarget(policy, …)`; a click that arrives before delivery still finds the row.
   */
  request(
    tx: Tx,
    input: {
      kind: ApprovalKind
      origin: ApprovalOrigin
      title: string
      /** For gateway.request: account handle + service, method host path, summary, and the asking chat. */
      body: string[]
      payload: unknown
      ttlMs: number
    },
  ): { approvalId: string }

  /** The Guard the host puts into every handler's context. Hold → request('procedure') → `held`. */
  guard: Guard

  /** Approve / Reject / Reject with reason… Authorized against the row's baked `approvers`. */
  onCardAction(action: CardAction, clicker: Caller): Promise<CardActionReply>
}

export function createApprovalLedger(deps: {
  db: Db
  accessLedger: AccessLedger
  agentLedger: AgentLedger
  chatLedger: ChatLedger
  cardPolicy: ApprovalCardPolicy
  /** Late-bound by the host: handlers live in domains above this one (session, gateway) and the router. */
  handlers: () => ApprovalHandlers
  /** Late-bound from session: an agent caller's session → its origin, for held procedures. */
  originOf: () => (sessionId: string) => ApprovalOrigin
}): ApprovalLedger {
  // TODO decide(id, decision, by):
  //   tx: row = select where id and status in (pending, awaiting_reason); none → already decided, no-op (double click)
  //       by ∉ row.approvers → refuse privately
  //       update status/decidedBy/decidedAt/reason
  //   after commit: chatLedger.editCard(row.cardRef, terminalCard(row)); await handlers()[row.kind](row, decision);
  //                 set handledAt
  // start(): decided rows with handledAt null → re-run handler; expired pending rows → decide(expire).
  //          Nothing is denied merely because the host restarted.
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { approvalLedger: ApprovalLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  list: os.list.handler(notImplemented),
  show: os.show.handler(notImplemented),
  decide: os.decide.handler(notImplemented),
})

export function systemJobs(approvalLedger: ApprovalLedger): SystemJob[] {
  // expire overdue rows; finalize ghosted "Reject with reason…" (awaiting_reason past 10 min → reject without reason)
  return [{ name: 'approval.expire', every: 60_000, run: async () => notImplemented() }]
}
