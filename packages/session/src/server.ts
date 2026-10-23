import { createHash, randomBytes } from 'node:crypto'

import type { AgentLedger } from '@kurumi/agent/server'
import type { ChatLedger, InboundEvent, InboundReceipt } from '@kurumi/chat/server'
import { transaction, type Db } from '@kurumi/rpc/server'
import { ORPCError } from '@orpc/server'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { sessionId, type AgentPrincipal } from './contract.ts'
import { container, inboundMessage, outboundMessage, session } from './schema.ts'

export { createDockerDriver } from './driver/docker.ts'
export { migrations } from '../migrations/index.ts'
export type { AgentPrincipal, SessionId } from './contract.ts'

export type ContainerEgress = {
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: true }[]
  network: { kind: 'default' } | { kind: 'lockdown'; dockerNetwork: string }
}
export type Admission =
  | { open: true }
  | {
      open: false
      reason: 'binding' | 'probing' | 'unreachable' | 'bind_failed'
      detail: string
      since: Date
    }
export type ContainerSpec = {
  containerId: string
  image: string
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: boolean }[]
  network: ContainerEgress['network']
  limits: { cpus: number; memoryMb: number; pids: number }
}
export type ContainerDriver = {
  run(spec: ContainerSpec): Promise<{ ok: true } | { ok: false; reason: string }>
  kill(containerId: string, graceMs: number): Promise<void>
  list(): Promise<{ containerId: string; running: boolean }[]>
  onExit(listener: (containerId: string, code: number) => void): () => void
}
export type SessionRuntime = {
  driver: ContainerDriver
  image: string
  egress: {
    admission(): Admission
    contribution(input: { agentGroupId: string; sessionToken: string }): ContainerEgress
  }
}
export type InboundLog = {
  kind: 'session.inbound.received' | 'session.inbound.committed'
  inboundId: string
  monotonicMs: number
}
export type SessionLedger = {
  routeInbound(event: InboundEvent): Promise<InboundReceipt>
  postOutbound(input: {
    id: string
    sessionId: string
    text: string
    inReplyTo?: string
  }): Promise<void>
  authenticate(token: string): AgentPrincipal | null
}
export type SessionDeps = {
  db: Db
  agentLedger: AgentLedger
  chatLedger: ChatLedger
  runtime?: SessionRuntime
  log?: (entry: InboundLog) => void
}

export function createSessionLedger({
  db,
  agentLedger,
  chatLedger,
  runtime,
  log,
}: SessionDeps): SessionLedger {
  const spawning = new Map<string, Promise<void>>()

  async function start(input: {
    containerId: string
    token: string
    agentGroupId: string
    folder: string
  }) {
    if (!runtime) return
    try {
      const egress = runtime.egress.contribution({
        agentGroupId: input.agentGroupId,
        sessionToken: input.token,
      })
      const result = await runtime.driver.run({
        containerId: input.containerId,
        image: runtime.image,
        env: { ...egress.env, KURUMI_TOKEN: input.token },
        mounts: [
          { hostPath: input.folder, containerPath: '/workspace/group', readonly: false },
          ...egress.mounts,
        ],
        network: egress.network,
        limits: { cpus: 1, memoryMb: 1024, pids: 256 },
      })
      transaction(db, (tx) => {
        if (result.ok) {
          tx.update(container)
            .set({ status: 'running' })
            .where(eq(container.id, input.containerId))
            .run()
        } else {
          tx.delete(container).where(eq(container.id, input.containerId)).run()
        }
      })
    } catch {
      transaction(db, (tx) => {
        tx.delete(container).where(eq(container.id, input.containerId)).run()
      })
    }
  }

  return {
    async routeInbound(event) {
      const inboundId = event.messageId
      log?.({ kind: 'session.inbound.received', inboundId, monotonicMs: event.receivedAt })
      const agent = agentLedger.get(event.platformId)
      if (!agent)
        throw new ORPCError('NOT_FOUND', { message: `agent not found: ${event.platformId}` })
      const admitted = runtime?.egress.admission().open ?? false
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
        let spawn: {
          containerId: string
          token: string
          agentGroupId: string
          folder: string
        } | null = null
        if (
          !existing &&
          admitted &&
          runtime &&
          !tx
            .select()
            .from(container)
            .where(
              and(
                eq(container.sessionId, current.id),
                inArray(container.status, ['starting', 'running']),
              ),
            )
            .get()
        ) {
          spawn = {
            containerId: `ctr-${crypto.randomUUID()}`,
            token: randomBytes(32).toString('base64url'),
            agentGroupId: agent.id,
            folder: agent.folder,
          }
          tx.insert(container)
            .values({
              id: spawn.containerId,
              sessionId: current.id,
              tokenHash: createHash('sha256').update(spawn.token).digest(),
              status: 'starting',
              image: runtime.image,
              startedAt: now,
            })
            .run()
        }
        return { receipt: { sessionId: current.id, inboundId, seq }, spawn }
      })
      log?.({ kind: 'session.inbound.committed', inboundId, monotonicMs: performance.now() })
      if (accepted.spawn) {
        const pending = start(accepted.spawn)
        spawning.set(accepted.receipt.sessionId, pending)
        try {
          await pending
        } finally {
          spawning.delete(accepted.receipt.sessionId)
        }
      } else {
        await spawning.get(accepted.receipt.sessionId)
      }
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
            inArray(container.status, ['starting', 'running']),
          ),
        )
        .get()
      return row
        ? { ...row, sessionId: sessionId.parse(row.sessionId), __brand: 'AgentPrincipal' }
        : null
    },
    async postOutbound(input) {
      const delivery = transaction(db, (tx) => {
        const current = tx.select().from(session).where(eq(session.id, input.sessionId)).get()
        if (!current)
          throw new ORPCError('NOT_FOUND', { message: `session not found: ${input.sessionId}` })
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
          if (existing.status !== 'failed') return null
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
        return current
      })
      if (!delivery) return
      let platformMessageId: string | null = null
      try {
        const target = delivery.messagingGroupId
          ? chatLedger.targetOf(delivery.messagingGroupId, delivery.threadId)
          : null
        const adapter = target ? chatLedger.adapter(target) : null
        if (target && adapter)
          platformMessageId = (await adapter.post(target, { id: input.id, text: input.text }))
            .platformMessageId
      } catch {
        platformMessageId = null
      }
      transaction(db, (tx) => {
        tx.update(outboundMessage)
          .set({ status: platformMessageId === null ? 'failed' : 'delivered', platformMessageId })
          .where(eq(outboundMessage.id, input.id))
          .run()
      })
    },
  }
}
