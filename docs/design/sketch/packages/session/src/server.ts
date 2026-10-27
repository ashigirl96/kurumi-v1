// @kurumi/session/server
import type { AccessLedger } from '@kurumi/access/server'
import type { AgentLedger } from '@kurumi/agent/server'
import type { ApprovalDecisionHandler, ApprovalLedger, ApprovalOrigin } from '@kurumi/approval/server'
import type { Card, CardAction, CardActionReply, ChatLedger, InboundEvent } from '@kurumi/chat/server'
import type { SystemJob } from '@kurumi/job/server'
import type { Caller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext, Tx } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { type AgentPrincipal, contract, type SessionId } from './contract.ts'

export { migrations } from '../migrations/index.ts'
export type { AgentPrincipal, SessionId }

/** What the egress side contributes to a spawn. No secret values: placeholders, proxy URL, CA path. */
export type ContainerEgress = {
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: true }[]
  network: { kind: 'default' } | { kind: 'lockdown'; dockerNetwork: string }
}

export type Admission =
  | { open: true }
  | { open: false; reason: 'binding' | 'probing' | 'unreachable' | 'bind_failed'; detail: string; since: Date }

export type SessionLedger = {
  start(): Promise<void>
  stop(): Promise<void>
  events: { subscribe(listener: (e: { type: 'change'; sessionId: string }) => void): () => void }

  /** Session Token → principal. Sync, one indexed read of container.token_hash. null = 407/401. */
  authenticate(token: string): AgentPrincipal | null

  /** Channels call this for every platform event (Slack, Console, terminal). The routing pipeline. */
  routeInbound(event: InboundEvent): Promise<void>

  // ── cross-domain writes: sync, caller's transaction first (monica ADR-0009). The host hands these to account
  //    and gateway as functions; neither imports this entry. ──
  /** Posts a host-built card into the session's Bound Chat. Returns the outbound message id. */
  postCard(tx: Tx, sessionId: string, card: Card): string
  /** Re-renders an already delivered card in place (delivery edits the platform message after commit). */
  replaceCard(tx: Tx, outboundMessageId: string, card: Card): void
  /** A triggered system message into the session: wakes or spawns the agent after commit. */
  notify(tx: Tx, sessionId: string, text: string): void
  /** Task run (schedule domain). Creates the series' task session on first use. */
  enqueueTask(
    tx: Tx,
    input: { agentGroupId: string; seriesId: string; prompt: string; processAfter: Date; script: string | null },
  ): void

  /** For approval cards: which chat asked, rendered once. */
  originOf(sessionId: string): ApprovalOrigin
  onCardAction(action: CardAction, clicker: Caller): Promise<CardActionReply>
  /** Sender Admission, Chat Registration, A2A holds: approve replays the held event through routeInbound. */
  onApproval: ApprovalDecisionHandler
}

/** Docker today; the seam exists so tests use a fake runtime (monica's fake ptyd pattern). */
export interface ContainerDriver {
  run(spec: ContainerSpec): Promise<{ ok: true } | { ok: false; reason: string }>
  kill(containerId: string, graceMs: number): Promise<void>
  list(): Promise<{ containerId: string; running: boolean }[]>
  onExit(listener: (containerId: string, code: number) => void): () => void
  buildImage(agentGroupId: string, packages: { apt: string[]; npm: string[] }): Promise<string>
  /**
   * Runs a throwaway container on the agent network that fetches `url` and checks the body equals `expect`.
   * The gateway's admission depends on it: a host listener nobody can reach must not count as "open".
   */
  probe(input: { url: string; expect: string; network: ContainerEgress['network'] }): Promise<boolean>
}

export type ContainerSpec = {
  containerId: string
  image: string
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: boolean }[]
  network: ContainerEgress['network']
  limits: { cpus: number; memoryMb: number; pids: number }
}

export function createDockerDriver(deps: { dockerPath: string }): ContainerDriver {
  throw new Error('not implemented')
}

export function createSessionLedger(deps: {
  db: Db
  home: string
  agentLedger: AgentLedger
  accessLedger: AccessLedger
  chatLedger: ChatLedger
  approvalLedger: ApprovalLedger
  /** Passed by the host from the gateway (gateway sits above session). */
  egress: {
    /** Proxy URL with the token as basic-auth password, KURUMI_URL/KURUMI_TOKEN for RPC, CA mount, placeholders. */
    contribution(input: { agentGroupId: string; sessionToken: string }): ContainerEgress
    admission(): Admission
  }
  driver: ContainerDriver
}): SessionLedger {
  // TODO internals:
  //   waiters: Map<sessionId, Set<() => void>>   (long polls parked in channel.pull)
  //   spawning: Map<sessionId, Promise<void>>    (dedupe concurrent wakes)
  //
  // wake(sessionId) after commit:
  //   live container row → resolve its pull waiters
  //   else if egress.admission().open → spawn(sessionId)   else leave pending; sweep retries (Gateway Outage)
  //
  // spawn(sessionId):
  //   token = 32 random bytes (base64url)
  //   tx: delete non-live container rows of the session (revokes); insert container{status:'starting', tokenHash}
  //   after commit: agentLedger.prepareWorkspace(group) (CLAUDE.md, container.json, skills)
  //                 egress.contribution({agentGroupId, sessionToken: token}) → env/mounts/network, i.e.
  //                   HTTPS_PROXY=http://s:<token>@host.docker.internal:<agentPort>, NO_PROXY=host.docker.internal,
  //                   KURUMI_URL=http://host.docker.internal:<agentPort>, KURUMI_TOKEN=<token>, CA, placeholders
  //   driver.run(spec) → on failure: delete container row, inbound stays pending (sweep retries)
  //
  // channel.pull(principal):
  //   tx: rows = pending ∧ due ∧ (session has a trigger row) ∪ processing ∧ claimedBy=principal.containerId
  //       update → processing, claimedBy; container.lastSeenAt = now; container.status = running
  //   empty → park in waiters until notify/route or waitMs
  //
  // reap(container) (exit event, stale heartbeat > 30 min, or no pull 60 s after start):
  //   tx: inbound where claimedBy=container ∧ processing → pending, tries+1 (≥5 → failed + tell the user)
  //       delete container row  ⇒ token revoked for proxy and RPC at once
  //   driver.kill (after commit)
  //
  // start(): adopt — driver inventory by label kurumi.container=<id>; rows without a docker container → reap;
  //   docker containers without a row → kill. Survivors keep their tokens (hash in DB) and reconnect.
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { sessionLedger: SessionLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  channel: {
    pull: os.channel.pull.handler(notImplemented),
    complete: os.channel.complete.handler(notImplemented),
    post: os.channel.post.handler(notImplemented),
    heartbeat: os.channel.heartbeat.handler(notImplemented),
    state: {
      get: os.channel.state.get.handler(notImplemented),
      put: os.channel.state.put.handler(notImplemented),
    },
  },
  sendMessage: os.sendMessage.handler(notImplemented),
  sendFile: os.sendFile.handler(notImplemented),
  editMessage: os.editMessage.handler(notImplemented),
  addReaction: os.addReaction.handler(notImplemented),
  sendCard: os.sendCard.handler(notImplemented),
  askUserQuestion: os.askUserQuestion.handler(notImplemented),
  postQuestion: os.postQuestion.handler(notImplemented),
  // runs only after approval (the guard holds agent callers): update container config, rebuild image, restart
  installPackages: os.installPackages.handler(notImplemented),
  addMcpServer: os.addMcpServer.handler(notImplemented),
  list: os.list.handler(notImplemented),
  show: os.show.handler(notImplemented),
  history: os.history.handler(notImplemented),
  restart: os.restart.handler(notImplemented),
  dropped: os.dropped.handler(notImplemented),
  policies: {
    list: os.policies.list.handler(notImplemented),
    set: os.policies.set.handler(notImplemented),
    remove: os.policies.remove.handler(notImplemented),
  },
})

/** Reconcile sweep (60 s): due rows → wake; stale containers → reap; queued outbound → deliver; echo prune. */
export function systemJobs(sessionLedger: SessionLedger): SystemJob[] {
  return [{ name: 'session.reconcile', every: 60_000, run: async () => notImplemented() }]
}
