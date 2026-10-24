import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'

import { createAccessLedger, router as accessRouter } from '@kurumi/access/server'
import {
  createAccountLedger,
  isInterceptedHost,
  router as accountRouter,
  storedAccounts,
  VaultError,
} from '@kurumi/account/server'
import { createAgentLedger, router as agentRouter } from '@kurumi/agent/server'
import {
  createApprovalLedger,
  router as approvalRouter,
  type ApprovalHandlers,
} from '@kurumi/approval/server'
import { createChatLedger, router as chatRouter } from '@kurumi/chat/server'
import {
  createEgressLog,
  createRuleStore,
  credentialInject,
  gatewayContribution,
  gatewayStatus,
  loadCertificateAuthority,
  proxyEnv,
  router as gatewayRouter,
  stageCaBundle,
  startAdmission,
  startAgentPort,
  type EgressLog,
  type RuleStore,
} from '@kurumi/gateway/server'
import { hostContract, type Caller } from '@kurumi/rpc/contract'
import { callByPath, guardRouter, type ApprovalGrant, type KurumiContext } from '@kurumi/rpc/server'
import {
  containerRevision,
  createDockerDriver,
  createSessionLedger,
  router as sessionRouter,
  type AgentPrincipal,
  type ContainerEgress,
} from '@kurumi/session/server'
import { implement, ORPCError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/node'
import { z } from 'zod'

import { loadConfig, type HostConfig } from './config.ts'
import { migrateAll, openKurumiDb, type KurumiDb } from './db.ts'
import { createRpcFronts, queryReadOnly } from './fronts.ts'
import { acquireLock } from './lock.ts'
import { migrations } from './migrations.ts'
import { loadVaultKey } from './vault-key.ts'

export type HostContext = KurumiContext & {
  db: KurumiDb
  agentLedger: ReturnType<typeof createAgentLedger>
  accessLedger: ReturnType<typeof createAccessLedger>
  approvalLedger: ReturnType<typeof createApprovalLedger>
  chatLedger: ReturnType<typeof createChatLedger>
  sessionLedger: ReturnType<typeof createSessionLedger>
  accountLedger: ReturnType<typeof createAccountLedger>
  gateway: {
    status(): ReturnType<typeof gatewayStatus>
    egressLog: Pick<EgressLog, 'rows'>
    rules: Pick<RuleStore, 'list' | 'add' | 'remove'>
  }
  agentPrincipal: AgentPrincipal | null
  requestSignal?: AbortSignal
}

const admin = implement(hostContract).$context<HostContext>()

export const hostRouter = guardRouter<HostContext>().router({
  agent: agentRouter,
  access: accessRouter,
  approval: approvalRouter,
  account: accountRouter,
  chat: chatRouter,
  session: sessionRouter,
  gateway: gatewayRouter,
  status: admin.status.handler(() => ({ ready: true })),
  db: {
    query: admin.db.query.handler(({ context, input }) => {
      if (context.caller.kind !== 'host') {
        throw new ORPCError('FORBIDDEN', { message: 'db query requires a host caller' })
      }
      return queryReadOnly(context.db.$client, input[0])
    }),
  },
})

export async function startHost(config: HostConfig) {
  process.stdout.write(
    `${JSON.stringify({ kind: 'host.start', pid: process.pid, timeOrigin: performance.timeOrigin, monotonicMs: performance.now() })}\n`,
  )
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  chmodSync(config.home, 0o700)
  const releaseLock = acquireLock(join(config.home, 'kurumi.lock'))
  let database: KurumiDb | undefined
  let listener: ReturnType<typeof Bun.serve> | undefined
  let chat: ReturnType<typeof createChatLedger> | undefined
  let sessions: ReturnType<typeof createSessionLedger> | undefined
  let driver: ReturnType<typeof createDockerDriver> | undefined
  let admission: ReturnType<typeof startAdmission> | undefined
  let egressLog: EgressLog | undefined
  let socketOwned = false
  let stopped: Promise<void> | undefined
  const socket = join(config.home, 'kurumi.sock')
  function stop(): Promise<void> {
    stopped ??= (async () => {
      chat?.stop()
      const results = await Promise.allSettled([
        sessions?.stop(),
        admission?.stop(),
        driver?.detach(),
        listener?.stop(true),
      ])
      try {
        egressLog?.stop()
        if (socketOwned) rmSync(socket, { force: true })
        database?.$client.close()
      } finally {
        releaseLock()
      }
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length) throw new AggregateError(failures, 'Host shutdown failed')
    })()
    return stopped
  }
  try {
    const milliseconds = z.coerce.number().int().max(2_147_483_647)
    const environment = z
      .object({
        KURUMI_AGENT_IMAGE: z.string().min(1).default('kurumi-agent:latest'),
        KURUMI_PROBE_IMAGE: z.string().min(1).optional(),
        KURUMI_DOCKER_NETWORK: z.string().min(1).default('bridge'),
        KURUMI_STALE_AFTER_MS: milliseconds.min(30_000).default(1_800_000),
        KURUMI_RECONCILE_INTERVAL_MS: milliseconds.min(100).optional(),
      })
      .parse(process.env)
    const staleAfterMs = environment.KURUMI_STALE_AFTER_MS
    const intervalMs =
      environment.KURUMI_RECONCILE_INTERVAL_MS ??
      Math.min(10_000, Math.floor((staleAfterMs - 26_000) / 3))
    if (25_000 + 3 * intervalMs > staleAfterMs)
      throw new Error(
        'KURUMI_STALE_AFTER_MS must be at least 25000 plus three KURUMI_RECONCILE_INTERVAL_MS, so that one host stall cannot make an idle runner look stale',
      )
    const install = createHash('sha256')
      .update(realpathSync(config.home))
      .digest('hex')
      .slice(0, 24)
    const db = openKurumiDb(join(config.home, 'kurumi.db'))
    database = db
    migrateAll(db, migrations)
    const requestLog = createEgressLog({
      db,
      log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    })
    egressLog = requestLog
    const vaultKey = loadVaultKey(config.home, storedAccounts(db))
    const ca = await loadCertificateAuthority({
      db,
      vaultKey,
      accountsStored: storedAccounts(db).count > 0,
      log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    }).catch((error: unknown) => {
      if (!(error instanceof VaultError)) throw error
      const dbPath = join(config.home, 'kurumi.db')
      throw new Error(
        `${join(config.home, 'vault.key')} cannot open the gateway CA in ${dbPath}: ${error.message}. If this vault.key did not seal the accounts, put back the one that did from your backup and start the host again. If it did, only the CA is unreadable: with the host stopped, run sqlite3 '${dbPath.replaceAll("'", `'\\''`)}' 'DELETE FROM gateway_ca;' and start the host, and kurumi creates a new CA.`,
        { cause: error },
      )
    })
    const caBundle = stageCaBundle(config.home, ca.certPem)
    const runner = join(config.home, 'runner/runner.js')
    const gateway = gatewayContribution({ port: config.agentPort.port, caBundle })
    const egress: ContainerEgress = {
      env: gateway.env,
      mounts: [
        { hostPath: runner, containerPath: '/app/runner.js', readonly: true },
        ...gateway.mounts,
      ],
      network: { kind: 'lockdown', dockerNetwork: environment.KURUMI_DOCKER_NETWORK },
    }
    const revisionedEgress = ({ sessionToken }: { sessionToken: string }): ContainerEgress => ({
      ...egress,
      env: { ...egress.env, ...proxyEnv({ port: config.agentPort.port, sessionToken }) },
    })
    const docker = createDockerDriver({
      install,
      revision: containerRevision({
        image: environment.KURUMI_AGENT_IMAGE,
        contribution: revisionedEgress,
        runner: existsSync(runner) ? readFileSync(runner) : new Uint8Array(),
      }),
      image: environment.KURUMI_PROBE_IMAGE ?? environment.KURUMI_AGENT_IMAGE,
      network: environment.KURUMI_DOCKER_NETWORK,
    })
    driver = docker
    const accountLedger = createAccountLedger({ db, vaultKey })
    const agentLedger = createAgentLedger({
      db,
      home: config.home,
      onCreate: (tx, agentGroupId) => accountLedger.grantAutoGrants(tx, agentGroupId),
    })
    const accessLedger = createAccessLedger({ db })
    const approvalLedger = createApprovalLedger({
      db,
      accessLedger,
      handlers: () => approvalHandlers,
      decidePath: ['approval', 'decide'],
      log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    })
    const chatLedger = createChatLedger({
      db,
      agentLedger,
      sink: () => ({ onInbound: (event) => sessionLedger.routeInbound(event) }),
    })
    chat = chatLedger
    const sessionLedger = createSessionLedger({
      db,
      agentLedger,
      chatLedger,
      log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      runtimeLog: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      runtime: {
        driver: docker,
        image: environment.KURUMI_AGENT_IMAGE,
        egress: {
          admission() {
            const state = admission?.status().state
            if (state?.kind === 'open') return { open: true }
            return {
              open: false,
              reason: state?.kind ?? 'binding',
              detail: 'Waiting for container reachability',
              since: new Date(),
            }
          },
          contribution: ({ agentGroupId, sessionToken }) => {
            const container = revisionedEgress({ sessionToken })
            return {
              ...container,
              env: { ...accountLedger.containerEnv(agentGroupId), ...container.env },
            }
          },
        },
        supervision: { staleAfterMs, intervalMs },
      },
    })
    sessions = sessionLedger
    const ledgers = {
      agentLedger,
      accessLedger,
      approvalLedger,
      chatLedger,
      sessionLedger,
      accountLedger,
      gateway: {
        status: () =>
          gatewayStatus({
            admission: admission?.status().state ?? { kind: 'binding' },
            agentPort: config.agentPort,
            caPem: ca.certPem,
          }),
        egressLog: requestLog,
        rules: createRuleStore({ db, accounts: accountLedger }),
      },
    }
    const contextFor = (caller: Caller, grant: ApprovalGrant | null = null): HostContext => ({
      db,
      caller,
      guard: approvalLedger.guard,
      grant,
      agentPrincipal: null,
      ...ledgers,
    })
    const approvalHandlers: ApprovalHandlers = {
      async procedure(approval, decision) {
        if (decision === 'deny') return
        const { path, input, caller } = approval.payload
        await callByPath(hostRouter, path, input, contextFor(caller, { approvalId: approval.id }))
      },
      'gateway.request': () =>
        Promise.reject(
          new Error('gateway.request approvals have no handler until the gateway produces them'),
        ),
    }
    const rpc = createRpcFronts(hostRouter, contextFor)
    const agentHandler = new RPCHandler(hostRouter)
    await approvalLedger.start()
    const started = sessionLedger.start()
    admission = startAdmission({
      bind: async (probeNonce) => {
        await sessionLedger.adopted()
        return startAgentPort<AgentPrincipal>({
          bind: config.agentPort,
          probeNonce,
          authenticate: (token) => sessionLedger.authenticate(token),
          ca,
          intercepts: isInterceptedHost,
          forward: { inject: credentialInject(accountLedger), log: requestLog.record },
          async rpc(request, response, principal, signal) {
            const result = await agentHandler.handle(request, response, {
              prefix: '/rpc',
              context: {
                ...contextFor({
                  kind: 'agent',
                  agentGroupId: principal.agentGroupId,
                  sessionId: principal.sessionId,
                }),
                agentPrincipal: principal,
                requestSignal: signal,
              },
            })
            if (!result.matched) response.writeHead(404).end()
          },
        })
      },
      probe: (url, options) => docker.probe(url, options),
      log: (message) => {
        process.stdout.write(`${JSON.stringify({ kind: 'gateway.admission', message })}\n`)
      },
    })
    const stale = lstatSync(socket, { throwIfNoEntry: false })
    if (stale && !stale.isSocket()) throw new Error(`${socket} exists and is not a socket`)
    rmSync(socket, { force: true })
    const umask = process.umask(0o177)
    try {
      listener = Bun.serve({ unix: socket, fetch: rpc.host })
      socketOwned = true
    } finally {
      process.umask(umask)
    }
    await started
    process.stdout.write(
      `${JSON.stringify({ kind: 'host.runtime', install, agentPort: config.agentPort.port, image: environment.KURUMI_AGENT_IMAGE })}\n`,
    )
    return { stop }
  } catch (error) {
    try {
      await stop()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Host startup and shutdown failed', {
        cause: cleanupError,
      })
    }
    throw error
  }
}

if (import.meta.main) {
  const starting = Promise.resolve().then(() => startHost(loadConfig(process.env)))
  const shutdown = () => {
    starting.then(
      (host) =>
        host.stop().then(
          () => process.exit(0),
          (error: unknown) => {
            process.stderr.write(`${String(error)}\n`)
            process.exit(1)
          },
        ),
      () => {},
    )
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  try {
    await starting
  } catch (error) {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
