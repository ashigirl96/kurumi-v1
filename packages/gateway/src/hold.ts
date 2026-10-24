import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

import type { AccountLedger } from '@kurumi/account/server'
import { transaction, type Db, type Tx } from '@kurumi/rpc/server'
import { and, asc, count, eq, gt } from 'drizzle-orm'

import type { EgressPrincipal } from './egress-log.ts'
import { pathWithoutQuery, type EgressGate, type ScreenInput, type Screened } from './forward.ts'
import type { HoldRefusal } from './refusal.ts'
import {
  createRuleStore,
  evaluate,
  normalizeHost,
  normalizeMethodOverrides,
  type RuleId,
  type RuleStore,
} from './rules.ts'
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
  /** Idempotent; never waits on the upstream. Throws when no allowance row exists. */
  decided(approval: { id: string }, decision: 'approve' | 'deny'): Promise<void>
  rules: RuleStore
}

export const HOLD_MS = 180_000
/**
 * Counted to the last body byte, not between bytes, so a body sent one byte at a time ends too. A held body
 * crosses only the container bridge, so a working client never comes near it.
 */
export const BODY_READ_MS = 30_000
export const ALLOWANCE_MS = 10 * 60_000
export const MAX_HELD_BODY_BYTES = 10 * 1024 * 1024
/** In flight: buffering a body or waiting on a person. */
export const MAX_IN_FLIGHT = 32
export const MAX_IN_FLIGHT_PER_GROUP = 8
export const MAX_UNDECIDED_PER_GROUP = 32
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
  methodOverrides: readonly string[]
  host: string
  contentType: readonly string[]
  contentEncoding: readonly string[]
  body: Buffer
  bodySha256: string
  fingerprint: Buffer
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data)

const normalizeFraming = (value: string) => value.trim().toLowerCase()

type InFlightLimit = Pick<Extract<HoldRefusal, { waiting: 'in_flight' }>, 'scope' | 'limit'>

function inFlightSlots() {
  let host = 0
  const byGroup = new Map<string, number>()
  return {
    /** Takes a slot for the group, or returns the limit that is full. */
    take(group: string): InFlightLimit | null {
      const held = byGroup.get(group) ?? 0
      if (held >= MAX_IN_FLIGHT_PER_GROUP) {
        return { scope: 'agent_group', limit: MAX_IN_FLIGHT_PER_GROUP }
      }
      if (host >= MAX_IN_FLIGHT) return { scope: 'host', limit: MAX_IN_FLIGHT }
      host++
      byGroup.set(group, held + 1)
      return null
    },
    release(group: string): void {
      host--
      const held = (byGroup.get(group) ?? 1) - 1
      if (held === 0) byGroup.delete(group)
      else byGroup.set(group, held)
    },
  }
}

type BodyRead = Buffer | 'too_large' | 'timeout' | 'gone'

function readBody(
  body: Readable | null,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<BodyRead> {
  if (body === null) return Promise.resolve(Buffer.alloc(0))
  if (signal.aborted) return Promise.resolve('gone')
  const read = Promise.withResolvers<BodyRead>()
  const chunks: Buffer[] = []
  let size = 0
  const finish = (result: BodyRead) => {
    clearTimeout(deadline)
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
  const deadline = setTimeout(() => finish('timeout'), deadlineMs)
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

function framingLine({ contentType, contentEncoding }: HeldRequest): string[] {
  const present = Object.entries({
    'content-type': contentType,
    'content-encoding': contentEncoding,
  })
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.map((value) => value || '(empty)').join(' and ')}`)
  return present.length > 0 ? [present.join(', ')] : []
}

function cardOf(held: HeldRequest) {
  const { input, ruleId, method, methodOverrides, host, body, bodySha256 } = held
  const override =
    methodOverrides.length > 0 ? `, method override ${methodOverrides.join(', ')}` : ''
  return {
    title: `${method} https://${host}${input.path} as ${input.account.handle}${override}`,
    body: [
      `agent group ${input.principal.agentGroupId}, session ${input.principal.sessionId}`,
      `rule ${ruleId}, service ${input.account.service}`,
      ...framingLine(held),
      ...(input.body === null
        ? ['WebSocket upgrade: an approval covers the whole connection and every message on it']
        : [`body ${body.length} bytes, sha256 ${bodySha256}`, preview(body)]),
    ],
  }
}

function noticeText(
  decision: 'approve' | 'deny',
  row: Pick<
    typeof egressAllowance.$inferSelect,
    'approvalId' | 'method' | 'host' | 'pathWithoutQuery' | 'accountHandle'
  >,
): string {
  const request = `${row.method} https://${row.host}${row.pathWithoutQuery} as ${row.accountHandle}`
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
  /** Queues `text` for the session once per key. */
  notify(notice: SessionNotice): unknown
  holdMs?: number
  bodyReadMs?: number
  now?: () => number
}): EgressApproval {
  const holdMs = deps.holdMs ?? HOLD_MS
  const bodyReadMs = deps.bodyReadMs ?? BODY_READ_MS
  const now = deps.now ?? Date.now
  const rules = createRuleStore({ db: deps.db, accounts: deps.accounts, now })
  const waiters = new Map<string, (end: HoldEnd) => void>()
  const inFlight = inFlightSlots()

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
        and(sameRequest, eq(egressAllowance.state, 'granted'), gt(egressAllowance.expiresAt, at)),
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
    if (undecided >= MAX_UNDECIDED_PER_GROUP) {
      return {
        kind: 'refuse',
        refusal: {
          code: 'approval_limit',
          service: account.service,
          waiting: 'undecided',
          limit: MAX_UNDECIDED_PER_GROUP,
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
        pathWithoutQuery: pathWithoutQuery(input.path),
        fingerprint,
        state: 'pending',
        createdAt: at,
      })
      .run()
    return { kind: 'wait', approvalId }
  }

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
    const body = await readBody(input.body, input.signal, bodyReadMs)
    if (body === 'too_large') return tooLarge
    if (body === 'timeout') {
      return { kind: 'refuse', refusal: { code: 'body_timeout', service, limitMs: bodyReadMs } }
    }
    if (body === 'gone') return { kind: 'abandoned' }
    const method = input.method.toUpperCase()
    const methodOverrides = normalizeMethodOverrides(input.methodOverrides)
    const host = normalizeHost(input.host)
    const contentType = input.contentType.map(normalizeFraming)
    const contentEncoding = input.contentEncoding.map(normalizeFraming)
    const bodySha256 = sha256(body).digest('hex')
    const held: HeldRequest = {
      input,
      ruleId,
      method,
      methodOverrides,
      host,
      contentType,
      contentEncoding,
      body,
      bodySha256,
      fingerprint: sha256(
        JSON.stringify([
          'kurumi.egress.v1',
          input.body === null ? 'websocket' : 'http',
          method,
          methodOverrides,
          host,
          input.path,
          input.account.handle,
          contentType,
          contentEncoding,
          bodySha256,
        ]),
      ).digest(),
    }
    const admission = transaction(deps.db, (tx) => admit(tx, held))
    if (admission.kind === 'pass') return { kind: 'forward', body }
    if (admission.kind === 'refuse') return admission
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
        pathAsSent: input.path,
      })
      if (verdict?.effect !== 'approve') return null
      const group = input.principal.agentGroupId
      const full = inFlight.take(group)
      if (full) {
        return Promise.resolve({
          kind: 'refuse',
          refusal: {
            code: 'approval_limit',
            service: input.account.service,
            waiting: 'in_flight',
            ...full,
          },
        })
      }
      return hold(input, verdict.ruleId).finally(() => inFlight.release(group))
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
          notify()
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
