import { createHash, randomBytes } from 'node:crypto'

import type { AgentLedger } from '@kurumi/agent/server'
import type { ChatLedger, InboundEvent, InboundReceipt } from '@kurumi/chat/server'
import { transaction, type Db, type Tx, type KurumiContext } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'

import {
  contract,
  sessionId,
  pullInput,
  completeInput,
  postInput,
  heartbeatInput,
  stateKeyInput,
  statePutInput,
  type AgentPrincipal,
  type Inbound,
  type PullInput,
  type CompleteInput,
  type PostInput,
  type HeartbeatInput,
  type StateKeyInput,
  type StatePutInput,
} from './contract.ts'
import type { ContainerDriver, ContainerInventory, ContainerSpec } from './driver/docker.ts'
import {
  createLiveness,
  createSupervisor,
  type ContainerRow,
  type SupervisionLog,
} from './reconcile.ts'
import { container, inboundMessage, outboundMessage, session, sessionState } from './schema.ts'

export { createDockerDriver } from './driver/docker.ts'
export type { ContainerDriver, ContainerInventory, ContainerSpec } from './driver/docker.ts'
export { migrations } from '../migrations/index.ts'
export type { AgentPrincipal, SessionId } from './contract.ts'

export type ContainerEgress = {
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: true }[]
  network: ContainerSpec['network']
}
export type Admission =
  | { open: true }
  | {
      open: false
      reason: 'binding' | 'probing' | 'unreachable' | 'bind_failed'
      detail: string
      since: Date
    }
export type SessionRuntime = {
  image: string
  egress: {
    admission(): Admission
    contribution(input: { agentGroupId: string; sessionToken: string }): ContainerEgress
  }
} & (
  | { driver: ContainerDriver; supervision?: undefined }
  | {
      driver: ContainerDriver & ContainerInventory
      supervision: { staleAfterMs: number; intervalMs: number }
    }
)
const REVISION_PLACEHOLDER = { agentGroupId: '<agent-group>', sessionToken: '<session-token>' }

export function containerRevision(input: {
  image: string
  contribution: SessionRuntime['egress']['contribution']
  runner: Uint8Array
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.image, input.contribution(REVISION_PLACEHOLDER)]))
    .update(input.runner)
    .digest('hex')
    .slice(0, 16)
}
export type InboundLog = {
  kind: 'session.inbound.received' | 'session.inbound.committed'
  inboundId: string
  monotonicMs: number
}
export type RuntimeLog =
  | {
      kind: 'session.outbound.delivered'
      inboundId: string | null
      outboundId: string
      monotonicMs: number
    }
  | {
      kind: 'session.restart.scheduled'
      sessionId: string
      containerId: string
      attempt: number
      delayMs: number
      monotonicMs: number
    }
  | { kind: 'session.cleanup.failed'; sessionId: string; containerId: string; monotonicMs: number }
  | {
      kind: 'session.container.reaped'
      sessionId: string
      containerId: string
      name: string | null
      reason: string
      monotonicMs: number
    }
  | SupervisionLog
type OutboundInput = { id: string; sessionId: string; text: string; inReplyTo?: string }
export type SessionLedger = {
  start(): Promise<void>
  adopted(): Promise<void>
  stop(): Promise<void>
  routeInbound(event: InboundEvent): Promise<InboundReceipt>
  postOutbound(input: OutboundInput): Promise<void>
  authenticate(token: string): AgentPrincipal | null
  channel: {
    pull(
      principal: AgentPrincipal,
      input: PullInput,
      signal?: AbortSignal,
    ): Promise<{ messages: Inbound[] }>
    complete(principal: AgentPrincipal, input: CompleteInput): Promise<void>
    post(principal: AgentPrincipal, input: PostInput): Promise<void>
    heartbeat(principal: AgentPrincipal, input: HeartbeatInput): void
    state: {
      get(principal: AgentPrincipal, input: StateKeyInput): { value: string | null }
      put(principal: AgentPrincipal, input: StatePutInput): void
    }
  }
}
export type SessionDeps = {
  db: Db
  agentLedger: AgentLedger
  chatLedger: ChatLedger
  runtime?: SessionRuntime
  log?: (entry: InboundLog) => void
  runtimeLog?: (entry: RuntimeLog) => void
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) throw new ORPCError('BAD_REQUEST', { message: result.error.message })
  return result.data
}

export function createSessionLedger({
  db,
  agentLedger,
  chatLedger,
  runtime,
  log,
  runtimeLog,
}: SessionDeps): SessionLedger {
  const spawning = new Map<string, Promise<void>>()
  const cleanups = new Map<string, Promise<void>>()
  const deliveries = new Map<string, Promise<void>>()
  const pulls = new Set<Promise<{ messages: Inbound[] }>>()
  const waiters = new Map<string, Set<() => void>>()
  const retries = new Map<string, { attempt: number; due: number }>()
  const liveness = createLiveness({ maxStepMs: 3 * (runtime?.supervision?.intervalMs ?? Infinity) })
  const supervision = runtime?.supervision
    ? { inventory: runtime.driver, ...runtime.supervision }
    : undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let enabled = false
  let stopped = false
  let stopping: Promise<void> | undefined

  function wake(id: string) {
    for (const notify of waiters.get(id) ?? []) notify()
  }

  function authorize(tx: Tx, principal: AgentPrincipal, { arrival = true } = {}) {
    if (stopped) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'host is stopping' })
    const row = tx
      .select({ id: container.id })
      .from(container)
      .innerJoin(session, eq(session.id, container.sessionId))
      .where(
        and(
          eq(container.id, principal.containerId),
          eq(container.sessionId, principal.sessionId),
          eq(session.agentGroupId, principal.agentGroupId),
          eq(session.status, 'active'),
          inArray(container.status, ['starting', 'running']),
        ),
      )
      .get()
    if (!row)
      throw new ORPCError('UNAUTHORIZED', { message: 'container incarnation is no longer active' })
    if (arrival) liveness.touch(principal.containerId)
  }

  function retire(id: string) {
    liveness.end(id)
    const retired = transaction(db, (tx) => {
      const row = tx.select().from(container).where(eq(container.id, id)).get()
      if (!row || row.status === 'stopping') return null
      tx.update(container).set({ status: 'stopping' }).where(eq(container.id, id)).run()
      tx.update(inboundMessage)
        .set({ status: 'pending', claimedBy: null })
        .where(
          and(
            eq(inboundMessage.sessionId, row.sessionId),
            eq(inboundMessage.claimedBy, id),
            eq(inboundMessage.status, 'processing'),
          ),
        )
        .run()
      return row
    })
    if (retired && !stopped) {
      const attempt = (retries.get(retired.sessionId)?.attempt ?? 0) + 1
      const delayMs = Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7))
      retries.set(retired.sessionId, { attempt, due: performance.now() + delayMs })
      runtimeLog?.({
        kind: 'session.restart.scheduled',
        sessionId: retired.sessionId,
        containerId: id,
        attempt,
        delayMs,
        monotonicMs: performance.now(),
      })
      wake(retired.sessionId)
    }
    return retired
  }

  function cleanup(id: string): Promise<void> {
    const active = cleanups.get(id)
    if (active) return active
    const task = Promise.resolve().then(async () => {
      await runtime?.driver.kill(id, 1_000)
      transaction(db, (tx) => {
        tx.delete(container)
          .where(and(eq(container.id, id), eq(container.status, 'stopping')))
          .run()
      })
    })
    cleanups.set(id, task)
    void task.finally(() => cleanups.delete(id)).catch(() => {})
    return task
  }

  function reap(id: string, reason: string, name: string | null) {
    const retired = retire(id)
    if (retired)
      runtimeLog?.({
        kind: 'session.container.reaped',
        sessionId: retired.sessionId,
        containerId: id,
        name,
        reason,
        monotonicMs: performance.now(),
      })
    void cleanup(id).catch(() => {})
  }

  const unsubscribe = runtime?.driver.onExit((id, code) => {
    if (stopped) return
    reap(id, `exited with code ${code}`, supervision?.inventory.nameOf(id) ?? null)
  })

  async function reconcileSession(id: string) {
    if (!runtime || stopped) return
    const rows = db.select().from(container).where(eq(container.sessionId, id)).all()
    for (const row of rows) {
      if (row.status !== 'stopping') return
      try {
        await cleanup(row.id)
      } catch {
        runtimeLog?.({
          kind: 'session.cleanup.failed',
          sessionId: id,
          containerId: row.id,
          monotonicMs: performance.now(),
        })
        return
      }
    }
    if (stopped || (enabled && (retries.get(id)?.due ?? 0) > performance.now())) return
    const pending = db
      .select()
      .from(inboundMessage)
      .where(
        and(
          eq(inboundMessage.sessionId, id),
          inArray(inboundMessage.status, ['pending', 'processing']),
        ),
      )
      .get()
    if (!pending || !runtime.egress.admission().open) return
    const current = db
      .select()
      .from(session)
      .where(and(eq(session.id, id), eq(session.status, 'active')))
      .get()
    const agent = current ? agentLedger.get(current.agentGroupId) : undefined
    if (!current || !agent) return
    const token = randomBytes(32).toString('base64url')
    const containerId = `ctr-${crypto.randomUUID()}`
    transaction(db, (tx) => {
      tx.insert(container)
        .values({
          id: containerId,
          sessionId: id,
          tokenHash: createHash('sha256').update(token).digest(),
          status: 'starting',
          image: runtime.image,
          startedAt: new Date(),
        })
        .run()
    })
    liveness.begin(containerId)
    try {
      const egress = runtime.egress.contribution({ agentGroupId: agent.id, sessionToken: token })
      const result = await runtime.driver.run({
        containerId,
        sessionId: id,
        image: runtime.image,
        env: { ...egress.env, KURUMI_TOKEN: token, KURUMI_SESSION_ID: id },
        mounts: [
          { hostPath: agent.folder, containerPath: '/workspace/group', readonly: false },
          ...egress.mounts,
        ],
        network: egress.network,
        limits: { cpus: 1, memoryMb: 1024, pids: 256 },
      })
      if (result.ok) {
        liveness.touch(containerId)
        transaction(db, (tx) => {
          tx.update(container)
            .set({ status: 'running' })
            .where(and(eq(container.id, containerId), eq(container.status, 'starting')))
            .run()
        })
        return
      }
    } catch {}
    retire(containerId)
    await cleanup(containerId).catch(() => {})
  }

  function reconcile(id: string): Promise<void> {
    const active = spawning.get(id)
    if (active) return active
    const task = reconcileSession(id)
    spawning.set(id, task)
    void task.finally(() => spawning.delete(id)).catch(() => {})
    return task
  }

  function tick() {
    if (stopped) return
    for (const current of db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.status, 'active'))
      .all()) {
      void reconcile(current.id).catch(() => {})
    }
  }

  function containerRows(nameOf: (containerId: string) => string): ContainerRow[] {
    return db
      .select({
        id: container.id,
        sessionId: container.sessionId,
        status: container.status,
        sessionStatus: session.status,
      })
      .from(container)
      .innerJoin(session, eq(session.id, container.sessionId))
      .all()
      .map((row) => ({
        id: row.id,
        name: nameOf(row.id),
        sessionId: row.sessionId,
        status: row.status,
        sessionActive: row.sessionStatus === 'active',
        liveness: liveness.view(row.id),
      }))
  }

  const supervisor =
    supervision &&
    createSupervisor({
      ...supervision,
      rows: () => containerRows((id) => supervision.inventory.nameOf(id)),
      accept(row) {
        const deadline = transaction(db, (tx) => {
          tx.update(container)
            .set({ status: 'running' })
            .where(
              and(eq(container.id, row.id), inArray(container.status, ['starting', 'running'])),
            )
            .run()
          return tx
            .select({ at: container.toolDeadlineAt })
            .from(container)
            .where(eq(container.id, row.id))
            .get()?.at
        })
        const toolMs = (deadline?.getTime() ?? 0) - Date.now()
        liveness.begin(row.id, toolMs > 0 ? toolMs : null)
      },
      reap,
      log: (entry) => runtimeLog?.(entry),
    })

  async function pull(
    principal: AgentPrincipal,
    input: PullInput,
    signal?: AbortSignal,
  ): Promise<{ messages: Inbound[] }> {
    const { waitMs } = parse(pullInput, input)
    const deadline = performance.now() + waitMs
    for (let arrival = true; ; arrival = false) {
      const notification = Promise.withResolvers<void>()
      const notify = () => notification.resolve()
      const listeners = waiters.get(principal.sessionId) ?? new Set<() => void>()
      waiters.set(principal.sessionId, listeners)
      listeners.add(notify)
      signal?.addEventListener('abort', notify, { once: true })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const messages = transaction(db, (tx) => {
          authorize(tx, principal, { arrival })
          signal?.throwIfAborted()
          const row = tx
            .select()
            .from(inboundMessage)
            .where(
              and(
                eq(inboundMessage.sessionId, principal.sessionId),
                inArray(inboundMessage.status, ['pending', 'processing']),
              ),
            )
            .orderBy(inboundMessage.seq)
            .get()
          if (!row || (row.processAfter && row.processAfter.getTime() > Date.now())) return []
          if (row.status === 'processing' && row.claimedBy !== principal.containerId) return []
          if (row.status === 'pending') {
            tx.update(inboundMessage)
              .set({ status: 'processing', claimedBy: principal.containerId, tries: row.tries + 1 })
              .where(eq(inboundMessage.id, row.id))
              .run()
          }
          return [
            {
              id: row.id,
              seq: row.seq,
              kind: row.kind,
              trigger: row.trigger,
              content: row.content,
            },
          ]
        })
        if (messages.length || performance.now() >= deadline) return { messages }
        timeout = setTimeout(notify, Math.max(0, deadline - performance.now()))
        await notification.promise
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
        signal?.removeEventListener('abort', notify)
        listeners.delete(notify)
        if (!listeners.size) waiters.delete(principal.sessionId)
      }
    }
  }

  async function deliver(input: OutboundInput, principal?: AgentPrincipal) {
    const current = transaction(db, (tx) => {
      if (principal) {
        authorize(tx, principal)
        const row = tx
          .select()
          .from(inboundMessage)
          .where(eq(inboundMessage.id, input.inReplyTo ?? ''))
          .get()
        if (
          !row ||
          row.sessionId !== principal.sessionId ||
          row.claimedBy !== principal.containerId ||
          !['processing', 'completed'].includes(row.status)
        )
          throw new ORPCError('FORBIDDEN')
      }
      const destination = tx.select().from(session).where(eq(session.id, input.sessionId)).get()
      if (!destination) throw new ORPCError('NOT_FOUND')
      const existing = tx
        .select()
        .from(outboundMessage)
        .where(eq(outboundMessage.id, input.id))
        .get()
      if (existing) {
        if (
          existing.sessionId !== input.sessionId ||
          existing.content !== input.text ||
          existing.inReplyTo !== (input.inReplyTo ?? null)
        ) {
          throw new ORPCError('CONFLICT', {
            message: 'outbound id already has different content or session',
          })
        }
        if (existing.status === 'delivered' || deliveries.has(input.id)) return null
        tx.update(outboundMessage)
          .set({ status: 'queued', attempts: existing.attempts + 1 })
          .where(eq(outboundMessage.id, input.id))
          .run()
      } else {
        const seq =
          (tx
            .select({ seq: sql<number>`coalesce(max(${outboundMessage.seq}), 0)` })
            .from(outboundMessage)
            .where(eq(outboundMessage.sessionId, input.sessionId))
            .get()?.seq ?? 0) + 1
        tx.insert(outboundMessage)
          .values({
            id: input.id,
            sessionId: input.sessionId,
            seq,
            inReplyTo: input.inReplyTo,
            kind: 'text',
            content: input.text,
            status: 'queued',
            attempts: 1,
            createdAt: new Date(),
          })
          .run()
      }
      return destination
    })
    if (!current) {
      await deliveries.get(input.id)
      return
    }
    const task = (async () => {
      let platformMessageId: string | null = null
      try {
        const target = current.messagingGroupId
          ? chatLedger.targetOf(current.messagingGroupId, current.threadId)
          : null
        const adapter = target ? chatLedger.adapter(target) : null
        if (target && adapter)
          platformMessageId = (await adapter.post(target, { id: input.id, text: input.text }))
            .platformMessageId
      } catch {}
      transaction(db, (tx) => {
        tx.update(outboundMessage)
          .set({ status: platformMessageId === null ? 'failed' : 'delivered', platformMessageId })
          .where(eq(outboundMessage.id, input.id))
          .run()
      })
      if (platformMessageId === null)
        throw new ORPCError('SERVICE_UNAVAILABLE', {
          message: 'outbound delivery failed; retry the same post',
        })
      runtimeLog?.({
        kind: 'session.outbound.delivered',
        inboundId: input.inReplyTo ?? null,
        outboundId: input.id,
        monotonicMs: performance.now(),
      })
    })()
    deliveries.set(input.id, task)
    try {
      await task
    } finally {
      deliveries.delete(input.id)
    }
  }

  return {
    async start() {
      if (stopped) throw new Error('session ledger stopped')
      if (enabled) return
      enabled = true
      await supervisor?.start()
      if (stopped) return
      timer = setInterval(tick, 100)
      timer.unref()
      tick()
    },
    adopted: () => supervisor?.adopted ?? Promise.resolve(),
    stop() {
      if (stopping) return stopping
      stopped = true
      clearInterval(timer)
      unsubscribe?.()
      for (const id of waiters.keys()) wake(id)
      stopping = Promise.allSettled([
        supervisor?.stop(),
        ...spawning.values(),
        ...cleanups.values(),
        ...deliveries.values(),
        ...pulls,
      ]).then(() => {})
      return stopping
    },
    async routeInbound(event) {
      const inboundId = event.messageId
      log?.({ kind: 'session.inbound.received', inboundId, monotonicMs: event.receivedAt })
      const agent = agentLedger.get(event.platformId)
      if (!agent)
        throw new ORPCError('NOT_FOUND', { message: `agent not found: ${event.platformId}` })
      if (stopped) throw new ORPCError('SERVICE_UNAVAILABLE')
      const accepted = transaction(db, (tx) => {
        const route = chatLedger.ensureTerminal(tx, agent.id)
        let current = tx
          .select()
          .from(session)
          .where(
            and(
              eq(session.agentGroupId, route.agentGroupId),
              eq(session.messagingGroupId, route.messagingGroupId),
              isNull(session.threadId),
              eq(session.mode, 'shared'),
            ),
          )
          .get()
        const now = new Date()
        if (!current) {
          current = {
            id: `ses-${crypto.randomUUID()}`,
            agentGroupId: agent.id,
            messagingGroupId: route.messagingGroupId,
            threadId: null,
            mode: 'shared',
            status: 'active',
            lastActiveAt: now,
            createdAt: now,
          }
          tx.insert(session).values(current).run()
        }
        const existing = tx
          .select()
          .from(inboundMessage)
          .where(eq(inboundMessage.id, inboundId))
          .get()
        if (existing && (existing.sessionId !== current.id || existing.content !== event.text)) {
          throw new ORPCError('CONFLICT', {
            message: 'inbound id already has different content or session',
          })
        }
        const seq =
          existing?.seq ??
          (tx
            .select({ seq: sql<number>`coalesce(max(${inboundMessage.seq}), 0)` })
            .from(inboundMessage)
            .where(eq(inboundMessage.sessionId, current.id))
            .get()?.seq ?? 0) + 1
        if (!existing) {
          tx.insert(inboundMessage)
            .values({
              id: inboundId,
              sessionId: current.id,
              seq,
              kind: 'chat',
              trigger: true,
              status: 'pending',
              content: event.text,
              createdAt: now,
            })
            .run()
          tx.update(session).set({ lastActiveAt: now }).where(eq(session.id, current.id)).run()
        }
        return { receipt: { sessionId: current.id, inboundId, seq } }
      })
      log?.({ kind: 'session.inbound.committed', inboundId, monotonicMs: performance.now() })
      wake(accepted.receipt.sessionId)
      await reconcile(accepted.receipt.sessionId)
      return accepted.receipt
    },
    authenticate(token) {
      const row = db
        .select({
          containerId: container.id,
          sessionId: session.id,
          agentGroupId: session.agentGroupId,
        })
        .from(container)
        .innerJoin(session, eq(session.id, container.sessionId))
        .where(
          and(
            eq(container.tokenHash, createHash('sha256').update(token).digest()),
            eq(session.status, 'active'),
            inArray(container.status, ['starting', 'running']),
          ),
        )
        .get()
      return row && liveness.has(row.containerId)
        ? { ...row, sessionId: sessionId.parse(row.sessionId), __brand: 'AgentPrincipal' }
        : null
    },
    async postOutbound(input) {
      if (stopped) throw new ORPCError('SERVICE_UNAVAILABLE')
      try {
        await deliver(input)
      } catch (error) {
        if (!(error instanceof ORPCError) || error.code !== 'SERVICE_UNAVAILABLE') throw error
      }
    },
    channel: {
      pull(principal, input, signal) {
        const task = pull(principal, input, signal)
        pulls.add(task)
        void task.finally(() => pulls.delete(task)).catch(() => {})
        return task
      },
      async complete(principal, input) {
        const { ids } = parse(completeInput, input)
        transaction(db, (tx) => {
          authorize(tx, principal)
          for (const id of ids) {
            const row = tx.select().from(inboundMessage).where(eq(inboundMessage.id, id)).get()
            if (
              !row ||
              row.sessionId !== principal.sessionId ||
              row.claimedBy !== principal.containerId ||
              !['processing', 'completed'].includes(row.status)
            )
              throw new ORPCError('FORBIDDEN')
            tx.update(inboundMessage)
              .set({ status: 'completed' })
              .where(eq(inboundMessage.id, id))
              .run()
          }
        })
        retries.delete(principal.sessionId)
        wake(principal.sessionId)
      },
      async post(principal, input) {
        const post = parse(postInput, input)
        await deliver(
          {
            id: post.id,
            sessionId: principal.sessionId,
            text: post.body.text,
            inReplyTo: post.inReplyTo,
          },
          principal,
        )
      },
      heartbeat(principal, input) {
        const heartbeat = parse(heartbeatInput, input)
        transaction(db, (tx) => {
          authorize(tx, principal)
          const now = new Date()
          liveness.declareTool(principal.containerId, heartbeat.toolTimeoutMs)
          tx.update(container)
            .set({
              lastSeenAt: now,
              currentTool: heartbeat.currentTool,
              toolDeadlineAt:
                heartbeat.toolTimeoutMs === null
                  ? null
                  : new Date(now.getTime() + heartbeat.toolTimeoutMs),
            })
            .where(eq(container.id, principal.containerId))
            .run()
        })
      },
      state: {
        get(principal, input) {
          const { key } = parse(stateKeyInput, input)
          return transaction(db, (tx) => {
            authorize(tx, principal)
            return {
              value:
                tx
                  .select()
                  .from(sessionState)
                  .where(
                    and(eq(sessionState.sessionId, principal.sessionId), eq(sessionState.key, key)),
                  )
                  .get()?.value ?? null,
            }
          })
        },
        put(principal, input) {
          const { key, value } = parse(statePutInput, input)
          transaction(db, (tx) => {
            authorize(tx, principal)
            tx.insert(sessionState)
              .values({ sessionId: principal.sessionId, key, value })
              .onConflictDoUpdate({
                target: [sessionState.sessionId, sessionState.key],
                set: { value },
              })
              .run()
          })
        },
      },
    },
  }
}

type ChannelContext = KurumiContext & {
  sessionLedger: SessionLedger
  agentPrincipal: AgentPrincipal | null
  requestSignal?: AbortSignal
}
const os = implement(contract).$context<ChannelContext>()
const agentOnly = os.middleware(({ context, next }) => {
  if (
    context.caller.kind !== 'agent' ||
    !context.agentPrincipal ||
    context.caller.sessionId !== context.agentPrincipal.sessionId ||
    context.caller.agentGroupId !== context.agentPrincipal.agentGroupId
  )
    throw new ORPCError('FORBIDDEN')
  return next({ context: { agentPrincipal: context.agentPrincipal } })
})
export const router = os.router({
  channel: {
    pull: os.channel.pull
      .use(agentOnly)
      .handler(({ context, input }) =>
        context.sessionLedger.channel.pull(context.agentPrincipal, input, context.requestSignal),
      ),
    complete: os.channel.complete
      .use(agentOnly)
      .handler(({ context, input }) =>
        context.sessionLedger.channel.complete(context.agentPrincipal, input),
      ),
    post: os.channel.post
      .use(agentOnly)
      .handler(({ context, input }) =>
        context.sessionLedger.channel.post(context.agentPrincipal, input),
      ),
    heartbeat: os.channel.heartbeat
      .use(agentOnly)
      .handler(({ context, input }) =>
        context.sessionLedger.channel.heartbeat(context.agentPrincipal, input),
      ),
    state: {
      get: os.channel.state.get
        .use(agentOnly)
        .handler(({ context, input }) =>
          context.sessionLedger.channel.state.get(context.agentPrincipal, input),
        ),
      put: os.channel.state.put
        .use(agentOnly)
        .handler(({ context, input }) =>
          context.sessionLedger.channel.state.put(context.agentPrincipal, input),
        ),
    },
  },
})
