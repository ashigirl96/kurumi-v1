// @kurumi/slack/server — Slack adapters (one per bot instance) and everything Slack-specific nanoclaw installed as
// skills: agent flow (per-agent bot), rooms + canvas, A2A rooms with hop limit, onboarding, thread titles, room
// membership / auto-wire, raw table text recovery.
import type { AgentLedger } from '@kurumi/agent/server'
import type { ApprovalLedger } from '@kurumi/approval/server'
import type { ChannelAdapter } from '@kurumi/chat/server'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import type { SessionLedger } from '@kurumi/session/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'

export type SlackLedger = {
  start(): Promise<void>
  stop(): Promise<void>
  /** One adapter per configured bot instance (ownerOnly: false); the host passes them to chat. */
  adapters(): ChannelAdapter[]
  /** Webhook mode: mounted by the host on the web listener at /slack/events/:instance. */
  webhook(instance: string, req: Request): Promise<Response>
}

export function createSlackLedger(deps: {
  db: Db
  vaultKey: Uint8Array
  agentLedger: AgentLedger
  sessionLedger: SessionLedger
  approvalLedger: ApprovalLedger
}): SlackLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { slackLedger: SlackLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  instances: { list: os.instances.list.handler(notImplemented), add: os.instances.add.handler(notImplemented) },
  rooms: { create: os.rooms.create.handler(notImplemented), addAgent: os.rooms.addAgent.handler(notImplemented) },
  canvas: { read: os.canvas.read.handler(notImplemented), update: os.canvas.update.handler(notImplemented) },
})
