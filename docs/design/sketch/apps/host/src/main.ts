// apps/host — the composition root. Assembles only; no domain logic.
// One process (launchd KeepAlive + RunAtLoad), one SQLite file, three listeners:
//   1. $KURUMI_HOME/kurumi.sock  (0600)  oRPC, caller = host           → apps/cli on the host machine
//   2. Agent Port (gateway-owned)        CONNECT = egress proxy, else oRPC with caller = agent (Session Token)
//   3. Web port (127.0.0.1 only)                          Console SPA + oRPC (caller = human),
//                                         /connect/:token, /oauth/callback, /slack/events/:instance
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

import { createAccessLedger, migrations as accessMigrations, router as accessRouter } from '@kurumi/access/server'
import {
  createAccountLedger,
  migrations as accountMigrations,
  router as accountRouter,
  systemJobs as accountJobs,
} from '@kurumi/account/server'
import { createAgentLedger, migrations as agentMigrations, router as agentRouter } from '@kurumi/agent/server'
import {
  type ApprovalHandlers,
  createApprovalLedger,
  migrations as approvalMigrations,
  router as approvalRouter,
  systemJobs as approvalJobs,
} from '@kurumi/approval/server'
import type { CardAction, CardActionReply, CardOwner } from '@kurumi/chat/contract'
import { type ChannelAdapter, createChatLedger, migrations as chatMigrations, router as chatRouter } from '@kurumi/chat/server'
import { createConsoleLedger, migrations as consoleMigrations, router as consoleRouter } from '@kurumi/console/server'
import {
  createGatewayLedger,
  migrations as gatewayMigrations,
  router as gatewayRouter,
  systemJobs as gatewayJobs,
} from '@kurumi/gateway/server'
import { createJobLedger } from '@kurumi/job/server'
import type { AgentCaller, Caller } from '@kurumi/rpc/contract'
import { guardRouter, type KurumiContext } from '@kurumi/rpc/server'
import {
  createScheduleLedger,
  migrations as scheduleMigrations,
  router as scheduleRouter,
  systemJobs as scheduleJobs,
} from '@kurumi/schedule/server'
import {
  createDockerDriver,
  createSessionLedger,
  migrations as sessionMigrations,
  router as sessionRouter,
  systemJobs as sessionJobs,
} from '@kurumi/session/server'
import { createSlackLedger, migrations as slackMigrations, router as slackRouter } from '@kurumi/slack/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { loadConfig } from './config.ts'
import { readOrCreateVaultKey } from './vault-key.ts'

const config = loadConfig(process.env)
mkdirSync(config.home, { recursive: true, mode: 0o700 })
chmodSync(config.home, 0o700)
// single host per $KURUMI_HOME: EXCLUSIVE already makes a 2nd host fail on its first query; the flock gives a clean message.
lockOrExit(openSync(join(config.home, 'kurumi.lock'), 'w'))

// Kept from monica (ADR-0007 is NOT kept: no stdin-EOF / ppid===1 suicide; launchd starts us with ppid 1).
const sqlite = new Database(join(config.home, 'kurumi.db'))
sqlite.run('PRAGMA locking_mode = EXCLUSIVE') // nothing else ever opens this file: containers use the Agent Port
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA foreign_keys = ON')
const db = drizzle(sqlite)

// FK order. Each package keeps its own __drizzle_migrations_<d> table (monica ADR-0010).
for (const m of [
  agentMigrations,
  accessMigrations,
  chatMigrations,
  approvalMigrations,
  sessionMigrations,
  scheduleMigrations,
  accountMigrations,
  gatewayMigrations,
  consoleMigrations,
  slackMigrations,
]) {
  migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
}

const vaultKey = readOrCreateVaultKey(join(config.home, 'vault.key')) // 0600, backed up with kurumi.db
const driver = createDockerDriver({ dockerPath: config.dockerPath })

// ── ledgers, lower domains first; upward values arrive as late-bound functions (monica ADR-0013) ──
const agentLedger = createAgentLedger({ db, home: config.home, templatesDir: config.templatesDir })
const accessLedger = createAccessLedger({ db })
const chatLedger = createChatLedger({
  db,
  agentLedger,
  accessLedger,
  adapters: () => [...slackLedger.adapters(), consoleLedger.adapter, terminalAdapter],
  sink: () => ({ onInbound: (e) => void sessionLedger.routeInbound(e), onCardAction: dispatchCardAction }),
})
const approvalLedger = createApprovalLedger({
  db,
  accessLedger,
  agentLedger,
  chatLedger,
  cardPolicy: config.approvalCardPolicy,
  handlers: () => approvalHandlers,
  originOf: () => (sessionId) => sessionLedger.originOf(sessionId),
})
const sessionLedger = createSessionLedger({
  db,
  home: config.home,
  agentLedger,
  accessLedger,
  chatLedger,
  approvalLedger,
  egress: {
    contribution: (input) => gatewayLedger.contribution(input),
    admission: () => gatewayLedger.admission(),
  },
  driver,
})
const scheduleLedger = createScheduleLedger({ db, sessionLedger, agentLedger })
const accountLedger = createAccountLedger({
  db,
  vaultKey,
  publicBaseUrl: config.publicBaseUrl,
  agentLedger,
  accessLedger,
  sessions: {
    postCard: (tx, sessionId, card) => sessionLedger.postCard(tx, sessionId, card),
    replaceCard: (tx, id, card) => sessionLedger.replaceCard(tx, id, card),
    notifySession: (tx, sessionId, text) => sessionLedger.notify(tx, sessionId, text),
  },
})
const consoleLedger = createConsoleLedger({ db, home: config.home })
const slackLedger = createSlackLedger({ db, vaultKey, agentLedger, sessionLedger, approvalLedger })

// ── the one router: CLI, Console and agents all call it; caller comes from the transport ──
const ledgers = {
  agentLedger,
  accessLedger,
  chatLedger,
  approvalLedger,
  sessionLedger,
  scheduleLedger,
  accountLedger,
  consoleLedger,
  slackLedger,
}
type HostContext = KurumiContext & typeof ledgers & { gatewayLedger: typeof gatewayLedger }
// Every procedure of every domain runs behind `guarded` (rpc/server): no meta.agent → agents refused; the rest
// goes to approvalLedger.guard. This is the only router that is mounted.
const router = guardRouter<HostContext>().router({
  agent: agentRouter,
  access: accessRouter,
  chat: chatRouter,
  approval: approvalRouter,
  session: sessionRouter,
  schedule: scheduleRouter,
  account: accountRouter,
  gateway: gatewayRouter,
  console: consoleRouter,
  slack: slackRouter,
})
const contextFor = (caller: Caller, grant: KurumiContext['grant'] = null): HostContext => ({
  db,
  caller,
  guard: approvalLedger.guard,
  grant,
  ...ledgers,
  gatewayLedger,
})
const rpc = createRpcFronts(router, contextFor)
// TODO createRpcFronts: one RPCHandler over `router`; three fetch fronts that differ only in the caller:
//   socket → {kind:'host'};  web → session cookie → {kind:'human', userId};  agent → given by the gateway.
//   `replay` re-invokes a held procedure with contextFor(originalCaller, { approvalId }).

const gatewayLedger = createGatewayLedger({
  db,
  home: config.home,
  vaultKey,
  bind: config.agentPort,
  containerHostName: config.containerHostName,
  egressLockdown: config.egressLockdown,
  accountLedger,
  sessionLedger,
  approvalLedger,
  probe: (input) => driver.probe(input),
  agentRpc: (req, caller) => rpc.agent(req, caller),
})

// Closed lists keyed by a union: forgetting one is a compile error, not a silent drop.
const approvalHandlers: ApprovalHandlers = {
  procedure: (approval, decision) => rpc.replay(approval, decision),
  'sender.admission': (a, d) => sessionLedger.onApproval(a, d),
  'chat.registration': (a, d) => sessionLedger.onApproval(a, d),
  'a2a.message': (a, d) => sessionLedger.onApproval(a, d),
  'gateway.request': (a, d) => gatewayLedger.onApprovalDecision(a, d),
}
const cardOwners: Record<CardOwner, (action: CardAction, clicker: Caller) => Promise<CardActionReply>> = {
  approval: (a, c) => approvalLedger.onCardAction(a, c),
  account: (a, c) => accountLedger.onCardAction(a, c),
  session: (a, c) => sessionLedger.onCardAction(a, c),
}
function dispatchCardAction(action: CardAction, clicker: Caller): Promise<CardActionReply> {
  return cardOwners[action.owner](action, clicker)
}

const jobLedger = createJobLedger({
  systemJobs: [
    ...sessionJobs(sessionLedger),
    ...scheduleJobs(scheduleLedger),
    ...accountJobs(accountLedger),
    ...gatewayJobs(gatewayLedger),
    ...approvalJobs(approvalLedger),
  ],
})

// ── start order: state first, then the doors ──
await approvalLedger.start() // re-runs handlers of decided-but-unhandled approvals
await sessionLedger.start() // adopt surviving containers (their Session Tokens are still valid)
accountLedger.start() // auto-grants for groups created while stopped
await gatewayLedger.start() // bind the Agent Port, run the probe container; admission opens only if it reaches us
await chatLedger.start() // channels last: inbound only once sessions can be woken
listenSocket(join(config.home, 'kurumi.sock'), rpc.host)
listenWeb(config.web, { rpc: rpc.human, account: accountLedger, slack: slackLedger, console: consoleLedger })
jobLedger.start()

process.on('SIGTERM', () => {
  // TODO stop in reverse without awaiting between closing the doors and exit; containers keep running (adopted next boot)
})

// stubs for the sketch
declare function createRpcFronts(
  router: object,
  contextFor: (caller: Caller, grant?: KurumiContext['grant']) => HostContext,
): {
  host: (req: Request) => Promise<Response>
  human: (req: Request) => Promise<Response>
  agent: (req: Request, caller: AgentCaller) => Promise<Response>
  replay: ApprovalHandlers['procedure']
}
declare const terminalAdapter: ChannelAdapter
declare function lockOrExit(fd: number): void
declare function listenSocket(path: string, handler: (req: Request) => Promise<Response>): void
declare function listenWeb(web: { host: string; port: number }, deps: object): void
