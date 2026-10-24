import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

import type { AccountLedger } from '@kurumi/account/server'
import { transaction, type Db, type Tx } from '@kurumi/rpc/server'
import { and, asc, count, eq, gt } from 'drizzle-orm'

import type { EgressPrincipal } from './egress-log.ts'
import type { EgressGate, ScreenInput, Screened } from './forward.ts'
import type { HoldRefusal } from './refusal.ts'
import { createRuleStore, evaluate, type RuleId, type RuleStore } from './rules.ts'
import { egressAllowance } from './schema.ts'

export type GatewayApprovals = {
  request(
    tx: Tx,
    input: {
      kind: 'gateway.request'
      agentGroupId: string
      sessionId: string
      title: string
      body: string[]
      payload: unknown
    },
  ): { approvalId: string }
}

export type SessionNotice = { key: string; sessionId: string; text: string }

export type EgressApproval = EgressGate<EgressPrincipal> & {
  /** The 'gateway.request' handler. Idempotent; never waits on the upstream. Throws when no allowance row exists. */
  decided(approval: { id: string }, decision: 'approve' | 'deny'): Promise<void>
  rules: RuleStore
}

export const HOLD_MS = 180_000
export const ALLOWANCE_MS = 10 * 60_000
export const MAX_HELD_BODY_BYTES = 10 * 1024 * 1024
/** nanoclaw's gateway approval coordinator refuses a held request at once when 32 already wait. */
export const MAX_HELD = 32
const PREVIEW_BYTES = 1024

type HoldEnd = 'approved' | 'denied' | 'timeout' | 'gone'

type Admission =
  | { kind: 'pass' }
  | { kind: 'wait'; approvalId: string }
  | { kind: 'refuse'; refusal: HoldRefusal }

type HeldRequest = {
  input: ScreenInput<EgressPrincipal>
  ruleId: RuleId
  method: string
  host: string
  body: Buffer
  bodySha256: string
  fingerprint: Buffer
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data)

const normalizeHost = (host: string) => host.toLowerCase().replace(/\.$/, '')

function pathWithoutQuery(path: string): string {
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

function readBody(
  body: Readable | null,
  signal: AbortSignal,
): Promise<Buffer | 'too_large' | 'gone'> {
  if (body === null) return Promise.resolve(Buffer.alloc(0))
  if (signal.aborted) return Promise.resolve('gone')
  const read = Promise.withResolvers<Buffer | 'too_large' | 'gone'>()
  const chunks: Buffer[] = []
  let size = 0
  const finish = (result: Buffer | 'too_large' | 'gone') => {
    body.off('data', onData)
    body.off('end', onEnd)
    body.off('error', onGone)
    signal.removeEventListener('abort', onGone)
    read.resolve(result)
  }
  const onData = (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_HELD_BODY_BYTES) finish('too_large')
    else chunks.push(chunk)
  }
  const onEnd = () => finish(Buffer.concat(chunks))
  const onGone = () => finish('gone')
  body.on('data', onData)
  body.once('end', onEnd)
  body.once('error', onGone)
  signal.addEventListener('abort', onGone, { once: true })
  return read.promise
}

function preview(body: Buffer): string {
  if (body.length === 0) return 'no body'
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, PREVIEW_BYTES), {
      stream: true,
    })
  } catch {
    return '(binary body)'
  }
}

function cardOf({ input, ruleId, method, host, body, bodySha256 }: HeldRequest) {
  return {
    title: `${method} https://${host}${input.path} as ${input.account.handle}`,
    body: [
      `agent group ${input.principal.agentGroupId}, session ${input.principal.sessionId}`,
      `rule ${ruleId}, service ${input.account.service}`,
      `body ${body.length} bytes, sha256 ${bodySha256}`,
      preview(body),
    ],
  }
}

function noticeText(
  decision: 'approve' | 'deny',
  row: Pick<
    typeof egressAllowance.$inferSelect,
    'approvalId' | 'method' | 'host' | 'path' | 'accountHandle'
  >,
): string {
  const request = `${row.method} https://${row.host}${row.path} as ${row.accountHandle}`
  switch (decision) {
    case 'approve':
      return `kurumi: approval ${row.approvalId} was approved: ${request}. The first attempt ended before the decision. Send exactly the same request with the same body within 10 minutes; it passes once. A changed body needs a new approval.`
    case 'deny':
      return `kurumi: approval ${row.approvalId} was denied: ${request}. Do not send this request again unless the user asks for it.`
    default: {
      const unknown: never = decision
      return unknown
    }
  }
}

export function createEgressApproval(deps: {
  db: Db
  accounts: Pick<AccountLedger, 'accountIdOf'>
  approvals: GatewayApprovals
  /** Returns a receipt and never throws. */
  notify(notice: SessionNotice): unknown
  holdMs?: number
  now?: () => number
}): EgressApproval {
  const holdMs = deps.holdMs ?? HOLD_MS
  const now = deps.now ?? Date.now
  const rules = createRuleStore({ db: deps.db, accounts: deps.accounts, now })
  /** approval id -> the one live hold on it. Only `wait` adds or deletes an entry. */
  const waiters = new Map<string, (end: HoldEnd) => void>()
  let inFlight = 0

  function admit(tx: Tx, held: HeldRequest): Admission {
    const { input, ruleId, fingerprint } = held
    const { principal, account } = input
    const at = new Date(now())
    const sameRequest = and(
      eq(egressAllowance.sessionId, principal.sessionId),
      eq(egressAllowance.ruleId, ruleId),
      eq(egressAllowance.fingerprint, fingerprint),
    )
    const granted = tx
      .select({ approvalId: egressAllowance.approvalId })
      .from(egressAllowance)
      .where(
        and(
          sameRequest,
          eq(egressAllowance.accountHandle, account.handle),
          eq(egressAllowance.state, 'granted'),
          gt(egressAllowance.expiresAt, at),
        ),
      )
      .orderBy(asc(egressAllowance.expiresAt))
      .get()
    if (granted) {
      tx.update(egressAllowance)
        .set({ state: 'used', usedAt: at })
        .where(eq(egressAllowance.approvalId, granted.approvalId))
        .run()
      return { kind: 'pass' }
    }
    const pending = tx
      .select({ approvalId: egressAllowance.approvalId })
      .from(egressAllowance)
      .where(and(sameRequest, eq(egressAllowance.state, 'pending')))
      .orderBy(asc(egressAllowance.createdAt))
      .get()
    if (pending) {
      return waiters.has(pending.approvalId)
        ? {
            kind: 'refuse',
            refusal: {
              code: 'approval_pending',
              service: account.service,
              approvalId: pending.approvalId,
            },
          }
        : { kind: 'wait', approvalId: pending.approvalId }
    }
    const undecided =
      tx
        .select({ rows: count() })
        .from(egressAllowance)
        .where(
          and(
            eq(egressAllowance.agentGroupId, principal.agentGroupId),
            eq(egressAllowance.state, 'pending'),
          ),
        )
        .get()?.rows ?? 0
    if (undecided >= MAX_HELD) {
      return {
        kind: 'refuse',
        refusal: {
          code: 'approval_limit',
          service: account.service,
          waiting: 'undecided',
          limit: MAX_HELD,
        },
      }
    }
    const { approvalId } = deps.approvals.request(tx, {
      kind: 'gateway.request',
      agentGroupId: principal.agentGroupId,
      sessionId: principal.sessionId,
      ...cardOf(held),
      payload: {},
    })
    tx.insert(egressAllowance)
      .values({
        approvalId,
        agentGroupId: principal.agentGroupId,
        sessionId: principal.sessionId,
        ruleId,
        accountHandle: account.handle,
        method: held.method,
        host: held.host,
        path: pathWithoutQuery(input.path),
        fingerprint,
        state: 'pending',
        createdAt: at,
      })
      .run()
    return { kind: 'wait', approvalId }
  }

  /** Every ending goes through `settle`, and the first one wins. */
  function wait(approvalId: string, signal: AbortSignal): Promise<HoldEnd> {
    if (signal.aborted) return Promise.resolve('gone')
    const ended = Promise.withResolvers<HoldEnd>()
    const settle = (end: HoldEnd) => {
      if (waiters.get(approvalId) !== settle) return
      waiters.delete(approvalId)
      clearTimeout(timer)
      signal.removeEventListener('abort', gone)
      ended.resolve(end)
    }
    const gone = () => settle('gone')
    const timer = setTimeout(() => settle('timeout'), holdMs)
    waiters.set(approvalId, settle)
    signal.addEventListener('abort', gone, { once: true })
    return ended.promise
  }

  async function hold(input: ScreenInput<EgressPrincipal>, ruleId: RuleId): Promise<Screened> {
    const { service } = input.account
    const tooLarge: Screened = {
      kind: 'refuse',
      refusal: { code: 'body_too_large', service, limit: MAX_HELD_BODY_BYTES },
    }
    if (input.declaredLength !== null && input.declaredLength > MAX_HELD_BODY_BYTES) return tooLarge
    const body = await readBody(input.body, input.signal)
    if (body === 'too_large') return tooLarge
    if (body === 'gone') return { kind: 'abandoned' }
    const method = input.method.toUpperCase()
    const host = normalizeHost(input.host)
    const bodySha256 = sha256(body).digest('hex')
    const held: HeldRequest = {
      input,
      ruleId,
      method,
      host,
      body,
      bodySha256,
      fingerprint: sha256(
        JSON.stringify([
          'kurumi.egress.v1',
          method,
          host,
          input.path,
          input.account.handle,
          bodySha256,
        ]),
      ).digest(),
    }
    const admission = transaction(deps.db, (tx) => admit(tx, held))
    switch (admission.kind) {
      case 'pass':
        return { kind: 'forward', body }
      case 'refuse':
        return admission
      case 'wait':
        break
      default: {
        const unknown: never = admission
        return unknown
      }
    }
    const { approvalId } = admission
    input.held()
    const end = await wait(approvalId, input.signal)
    switch (end) {
      case 'approved':
        return { kind: 'forward', body }
      case 'denied':
        return { kind: 'refuse', refusal: { code: 'approval_denied', service, approvalId } }
      case 'timeout':
      case 'gone':
        return { kind: 'refuse', refusal: { code: 'approval_pending', service, approvalId } }
      default: {
        const unknown: never = end
        return unknown
      }
    }
  }

  const allowanceOf = (approvalId: string) =>
    deps.db.select().from(egressAllowance).where(eq(egressAllowance.approvalId, approvalId)).get()

  /** Synchronous, so the live waiter takes the grant before any client event can run. */
  function takeLive(approvalId: string): boolean {
    const settle = waiters.get(approvalId)
    if (!settle) return false
    const used = transaction(deps.db, (tx) =>
      tx
        .update(egressAllowance)
        .set({ state: 'used', usedAt: new Date(now()) })
        .where(
          and(eq(egressAllowance.approvalId, approvalId), eq(egressAllowance.state, 'granted')),
        )
        .returning({ approvalId: egressAllowance.approvalId })
        .get(),
    )
    if (!used) return false
    settle('approved')
    return true
  }

  return {
    rules,
    screen(input) {
      const verdict = evaluate(rules.read(input.account), {
        handle: input.account.handle,
        service: input.account.service,
        host: input.host,
        method: input.method,
        methodOverrides: input.methodOverrides,
        path: input.path,
      })
      if (verdict?.effect !== 'approve') return null
      if (inFlight >= MAX_HELD) {
        return Promise.resolve({
          kind: 'refuse',
          refusal: {
            code: 'approval_limit',
            service: input.account.service,
            waiting: 'in_flight',
            limit: MAX_HELD,
          },
        })
      }
      inFlight++
      return hold(input, verdict.ruleId).finally(() => {
        inFlight--
      })
    },
    async decided(approval, decision) {
      const row = allowanceOf(approval.id)
      if (!row) throw new Error(`gateway approval ${approval.id} has no egress allowance row`)
      const notify = () => {
        deps.notify({
          key: approval.id,
          sessionId: row.sessionId,
          text: noticeText(decision, row),
        })
      }
      switch (decision) {
        case 'approve': {
          transaction(deps.db, (tx) => {
            tx.update(egressAllowance)
              .set({ state: 'granted', expiresAt: new Date(now() + ALLOWANCE_MS) })
              .where(
                and(
                  eq(egressAllowance.approvalId, approval.id),
                  eq(egressAllowance.state, 'pending'),
                ),
              )
              .run()
          })
          if (takeLive(approval.id)) return
          const current = allowanceOf(approval.id)
          if (current?.state === 'granted' && (current.expiresAt?.getTime() ?? 0) > now()) notify()
          return
        }
        case 'deny': {
          transaction(deps.db, (tx) => {
            tx.update(egressAllowance)
              .set({ state: 'denied' })
              .where(
                and(
                  eq(egressAllowance.approvalId, approval.id),
                  eq(egressAllowance.state, 'pending'),
                ),
              )
              .run()
          })
          const settle = waiters.get(approval.id)
          if (settle) {
            settle('denied')
            return
          }
          if (allowanceOf(approval.id)?.state === 'denied') notify()
          return
        }
        default: {
          const unknown: never = decision
          return unknown
        }
      }
    },
  }
}
