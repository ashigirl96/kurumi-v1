import type { AgentLedger } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext, Tx } from '@kurumi/rpc/server'
import { AsyncIteratorClass, implement, ORPCError } from '@orpc/server'
import { and, eq } from 'drizzle-orm'

import {
  contract,
  type CardActionReply,
  type ChannelAdapter,
  type DeliveryTarget,
  type InboundEvent,
  type InboundReceipt,
  type TerminalEvent,
  type TerminalInput,
} from './contract.ts'
import { messagingGroup, wiring } from './schema.ts'
import { createTerminalAdapter } from './terminal.ts'

export { migrations } from '../migrations/index.ts'
export type { ChannelAdapter, DeliveryTarget, InboundEvent, InboundReceipt } from './contract.ts'

export type TerminalRoute = { messagingGroupId: string; agentGroupId: string; mode: 'shared' }
export type ChatLedger = {
  ensureTerminal(tx: Tx, agentGroupId: string): TerminalRoute
  adapter(key: { channel: string; instance: string | null }): ChannelAdapter | null
  targetOf(messagingGroupId: string, threadId: string | null): DeliveryTarget | null
  terminal(input: TerminalInput, signal?: AbortSignal): AsyncGenerator<TerminalEvent, void>
  press(input: { ref: string; action: string }, caller: Caller): CardActionReply
  stop(): void
}

export function createChatLedger({
  db,
  agentLedger,
  sink,
}: {
  db: Db
  agentLedger: AgentLedger
  sink: () => {
    onInbound(event: InboundEvent): Promise<InboundReceipt>
    onCardAction?(input: { ref: string; action: string }, caller: Caller): CardActionReply
  }
}): ChatLedger {
  const terminalAdapter = createTerminalAdapter()
  return {
    press(input, caller) {
      return (
        sink().onCardAction?.(input, caller) ?? {
          kind: 'notice',
          text: 'このカードは利用できません',
        }
      )
    },
    ensureTerminal(tx, agentGroupId) {
      const agent = agentLedger.get(agentGroupId)
      if (!agent) throw new ORPCError('NOT_FOUND', { message: `agent not found: ${agentGroupId}` })
      const existing = tx
        .select()
        .from(messagingGroup)
        .where(
          and(
            eq(messagingGroup.channel, 'terminal'),
            eq(messagingGroup.instance, ''),
            eq(messagingGroup.platformId, agentGroupId),
          ),
        )
        .get()
      const messagingGroupId = existing?.id ?? `mg-${crypto.randomUUID()}`
      if (!existing) {
        tx.insert(messagingGroup)
          .values({
            id: messagingGroupId,
            channel: 'terminal',
            instance: '',
            platformId: agentGroupId,
            name: agent.name,
            isGroup: false,
            unknownSenderPolicy: 'strict',
            createdAt: new Date(),
          })
          .run()
      }
      tx.insert(wiring)
        .values({
          id: `wir-${crypto.randomUUID()}`,
          messagingGroupId,
          agentGroupId,
          engageMode: 'mention',
          sessionMode: 'shared',
          senderScope: 'all',
          accumulate: false,
          threads: false,
          priority: 0,
        })
        .onConflictDoNothing({ target: [wiring.messagingGroupId, wiring.agentGroupId] })
        .run()
      return { messagingGroupId, agentGroupId, mode: 'shared' }
    },
    adapter(key) {
      return key.channel === 'terminal' && key.instance === null ? terminalAdapter : null
    },
    targetOf(messagingGroupId, threadId) {
      const group = db
        .select()
        .from(messagingGroup)
        .where(eq(messagingGroup.id, messagingGroupId))
        .get()
      if (!group) return null
      return {
        channel: group.channel,
        instance: group.instance === '' ? null : group.instance,
        platformId: group.platformId,
        threadId,
      }
    },
    terminal(input, signal) {
      const controller = new AbortController()
      const cancelled = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      let routed = false
      let replies: ReturnType<typeof terminalAdapter.subscribe> | undefined
      return new AsyncIteratorClass<TerminalEvent, void, void>(
        async () => {
          if (cancelled.aborted) return { done: true, value: undefined }
          if (routed) return replies ? replies.next() : { done: true, value: undefined }
          routed = true
          const receivedAt = performance.now()
          if (!agentLedger.get(input.agentGroupId)) {
            throw new ORPCError('NOT_FOUND', { message: `agent not found: ${input.agentGroupId}` })
          }
          const target: DeliveryTarget = {
            channel: 'terminal',
            instance: null,
            platformId: input.agentGroupId,
            threadId: null,
          }
          replies = input.follow ? terminalAdapter.subscribe(target, cancelled) : undefined
          const receipt = await sink().onInbound({
            channel: 'terminal',
            instance: null,
            platformId: input.agentGroupId,
            threadId: null,
            messageId: `in-${crypto.randomUUID()}`,
            receivedAt,
            text: input.text,
            sender: { handle: 'terminal:owner', displayName: 'Owner', isBot: false },
            isMention: true,
            isGroup: false,
            attachments: [],
          })
          if (cancelled.aborted) return { done: true, value: undefined }
          return { done: false, value: { kind: 'queued', ...receipt } }
        },
        async () => {
          controller.abort()
          await replies?.return?.()
        },
      )
    },
    stop: () => terminalAdapter.stop(),
  }
}

const os = implement(contract).$context<KurumiContext & { chatLedger: ChatLedger }>()
export const router = os.router({
  press: os.press.handler(({ input, context }) => context.chatLedger.press(input, context.caller)),
  terminal: os.terminal.handler(({ input, context, signal }) => {
    if (context.caller.kind !== 'host') {
      throw new ORPCError('FORBIDDEN', { message: 'terminal chat requires the host caller' })
    }
    return context.chatLedger.terminal(input, signal)
  }),
})
