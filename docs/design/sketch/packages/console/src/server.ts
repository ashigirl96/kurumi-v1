// @kurumi/console/server — the Console channel (owner's web chat) and its own state.
// ui/ (not sketched): React 19 pages — Sidebar, Chat (renders Card incl. Connect Card), Inbox, Panel, NewAgentDialog,
// GroupChatDialogs, Accounts (per group: grants per service, default, connect, revoke — calls account.*;
// replaces OneCLI's dashboard and nanoclaw ADR-0003's read-only list).
import type { ChannelAdapter } from '@kurumi/chat/server'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'

export type ConsoleLedger = {
  start(): void
  stop(): void
  events: { subscribe(listener: (e: { type: 'change'; chatId: string }) => void): () => void }
  /** The Console as a ChannelAdapter (ownerOnly: true): post/edit write console_message and signal `events`. */
  adapter: ChannelAdapter
}

export function createConsoleLedger(deps: { db: Db; home: string }): ConsoleLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { consoleLedger: ConsoleLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  chats: { list: os.chats.list.handler(notImplemented) },
  messages: { list: os.messages.list.handler(notImplemented), send: os.messages.send.handler(notImplemented) },
  files: { get: os.files.get.handler(notImplemented) },
  unread: { mark: os.unread.mark.handler(notImplemented) },
  inbox: os.inbox.handler(notImplemented),
  groupChats: { create: os.groupChats.create.handler(notImplemented), remove: os.groupChats.remove.handler(notImplemented) },
  appearance: { set: os.appearance.set.handler(notImplemented) },
  events: os.events.handler(notImplemented),
})
