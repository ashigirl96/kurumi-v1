// @kurumi/chat/server
// Static chat model (Messaging Group, Wiring, Destination, User DM) + the channel adapter seam.
// Routing decisions (engage, sender scope, admission) live in session, which is the one that acts on them.
import type { AccessLedger } from '@kurumi/access/server'
import type { AgentLedger } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { type Card, type CardAction, type CardActionReply, contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'
export type { Card, CardAction, CardActionReply }

/** A platform event, already decoded by its adapter. No platform SDK types past this line. */
export type InboundEvent = {
  channel: string // adapter kind: 'slack' | 'console' | 'terminal'
  instance: string | null // which Slack bot
  platformId: string // channel / DM id
  threadId: string | null
  messageId: string
  sender: { handle: string; displayName: string; isBot: boolean }
  text: string
  isMention: boolean
  isGroup: boolean
  attachments: { name: string; mime: string; bytes: Uint8Array }[]
}

export type DeliveryTarget = { channel: string; instance: string | null; platformId: string; threadId: string | null }

/** Where a delivered card lives, so it can be edited. Opaque outside the adapter that made it. */
export type CardRef = { channel: string; instance: string | null; platformId: string; platformMessageId: string }

/**
 * What a platform must implement. Delivery is by exact adapter key (instance ?? channel); never rerouted through
 * a sibling bot.
 */
export interface ChannelAdapter {
  readonly kind: string
  readonly instance: string | null
  /** Owner-only chats (the Console) may receive approval cards in place; see approval's cardTarget. */
  readonly ownerOnly: boolean
  start(sink: {
    onInbound(event: InboundEvent): void
    /** The adapter renders the reply privately to the clicker. */
    onCardAction(action: CardAction, clicker: { handle: string }): Promise<CardActionReply>
  }): Promise<void>
  stop(): Promise<void>
  post(
    target: DeliveryTarget,
    body: { text: string } | { card: Card } | { file: { name: string; bytes: Uint8Array } },
  ): Promise<{ platformMessageId: string }>
  edit(target: DeliveryTarget, platformMessageId: string, body: { text: string } | { card: Card }): Promise<void>
  react(target: DeliveryTarget, platformMessageId: string, emoji: string): Promise<void>
  setTyping(target: DeliveryTarget, on: boolean): Promise<void>
  openDm(userHandle: string): Promise<{ platformId: string } | null>
}

export type ChatLedger = {
  start(): Promise<void>
  stop(): Promise<void>
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }
  adapter(key: { channel: string; instance: string | null }): ChannelAdapter | null
  /** The user's DM on `preferChannel` if reachable, else any channel (user_dm cache, adapter.openDm). */
  dmOf(userId: string, preferChannel: string | null): Promise<DeliveryTarget | null>
  /** Host cards outside any session (approval cards). */
  deliverCard(target: DeliveryTarget, card: Card): Promise<CardRef>
  editCard(ref: CardRef, card: Card): Promise<void>
  /** Bound chat of a messaging group, for approval cards that go to the origin chat. */
  targetOf(messagingGroupId: string, threadId: string | null): (DeliveryTarget & { ownerOnly: boolean }) | null
}

export function createChatLedger(deps: {
  db: Db
  agentLedger: AgentLedger
  accessLedger: AccessLedger
  /**
   * Assembled by the host from the channel packages (the only list of channels). Read at start(): channel
   * packages sit above session, so they are constructed after chat.
   */
  adapters: () => readonly ChannelAdapter[]
  /** Fan-in, late-bound by the host to session.routeInbound and the card-owner map. */
  sink: () => {
    onInbound(e: InboundEvent): void
    onCardAction(a: CardAction, clicker: Caller): Promise<CardActionReply>
  }
}): ChatLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { chatLedger: ChatLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  messagingGroups: {
    list: os.messagingGroups.list.handler(notImplemented),
    show: os.messagingGroups.show.handler(notImplemented),
    create: os.messagingGroups.create.handler(notImplemented),
    update: os.messagingGroups.update.handler(notImplemented),
    remove: os.messagingGroups.remove.handler(notImplemented),
    send: os.messagingGroups.send.handler(notImplemented),
  },
  wirings: {
    list: os.wirings.list.handler(notImplemented),
    create: os.wirings.create.handler(notImplemented),
    update: os.wirings.update.handler(notImplemented),
    remove: os.wirings.remove.handler(notImplemented),
  },
  destinations: {
    list: os.destinations.list.handler(notImplemented),
    add: os.destinations.add.handler(notImplemented),
    remove: os.destinations.remove.handler(notImplemented),
  },
  userDms: { list: os.userDms.list.handler(notImplemented) },
  terminal: os.terminal.handler(notImplemented),
})
