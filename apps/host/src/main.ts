import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createAccountLedger } from '@kurumi/account/server'
import { createAgentLedger, router as agentRouter } from '@kurumi/agent/server'
import { createChatLedger, router as chatRouter } from '@kurumi/chat/server'
import { startAdmission, startAgentPort } from '@kurumi/gateway/server'
import { hostContract, type Caller } from '@kurumi/rpc/contract'
import { guardRouter, type Guard, type KurumiContext } from '@kurumi/rpc/server'
import {
  createDockerDriver,
  createSessionLedger,
  router as sessionRouter,
  type AgentPrincipal,
} from '@kurumi/session/server'
import { implement, ORPCError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/node'
import { z } from 'zod'

import { loadConfig, type HostConfig } from './config.ts'
import { migrateAll, openKurumiDb, type KurumiDb } from './db.ts'
import { createRpcFronts, queryReadOnly } from './fronts.ts'
import { acquireLock } from './lock.ts'
import { migrations } from './migrations.ts'

export const initialGuard: Guard = ({ caller, meta }) =>
  caller.kind !== 'agent' || meta.agent === 'channel'
    ? { kind: 'allow' }
    : { kind: 'deny', reason: 'This procedure is not available to agents' }

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
        KURUMI_RECONCILE_INTERVAL_MS: milliseconds.min(100).default(10_000),
      })
      .parse(process.env)
    const install = createHash('sha256')
      .update(realpathSync(config.home))
      .digest('hex')
      .slice(0, 24)
    const docker = createDockerDriver({
      install,
      image: environment.KURUMI_PROBE_IMAGE ?? environment.KURUMI_AGENT_IMAGE,
      network: environment.KURUMI_DOCKER_NETWORK,
    })
    driver = docker
    const db = openKurumiDb(join(config.home, 'kurumi.db'))
    database = db
    migrateAll(db, migrations)
    const agentLedger = createAgentLedger({ db, home: config.home })
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
          contribution: () => ({
            env: {
              KURUMI_URL: `http://host.docker.internal:${config.agentPort.port}`,
              KURUMI_AGENT_PORT: String(config.agentPort.port),
            },
            mounts: [
              {
                hostPath: join(config.home, 'runner/runner.js'),
                containerPath: '/app/runner.js',
                readonly: true,
              },
            ],
            network: { kind: 'lockdown', dockerNetwork: environment.KURUMI_DOCKER_NETWORK },
          }),
        },
        supervision: {
          inventory: docker,
          staleAfterMs: environment.KURUMI_STALE_AFTER_MS,
          intervalMs: environment.KURUMI_RECONCILE_INTERVAL_MS,
        },
      },
    })
    sessions = sessionLedger
    const ledgers = {
      agentLedger,
      chatLedger,
      sessionLedger,
      accountLedger: createAccountLedger({ db }),
    }
    type HostContext = KurumiContext &
      typeof ledgers & {
        agentPrincipal: AgentPrincipal | null
        requestSignal?: AbortSignal
      }
    const admin = implement(hostContract).$context<HostContext>()
    const router = guardRouter<HostContext>().router({
      agent: agentRouter,
      chat: chatRouter,
      session: sessionRouter,
      status: admin.status.handler(() => ({ ready: true })),
      db: {
        query: admin.db.query.handler(({ context, input }) => {
          if (context.caller.kind !== 'host') {
            throw new ORPCError('FORBIDDEN', { message: 'db query requires a host caller' })
          }
          return queryReadOnly(db.$client, input[0])
        }),
      },
    })
    const contextFor = (caller: Caller): HostContext => ({
      db,
      caller,
      guard: initialGuard,
      grant: null,
      agentPrincipal: null,
      ...ledgers,
    })
    const rpc = createRpcFronts(router, contextFor)
    const agentHandler = new RPCHandler(router)
    const adopted = sessionLedger.start()
    admission = startAdmission({
      bind: async (probeNonce) => {
        await adopted
        return startAgentPort({
          bind: config.agentPort,
          probeNonce,
          authenticate: (token) => sessionLedger.authenticate(token),
          intercepts: () => false,
          forward: { inject: ({ path, headers }) => ({ path, headers }) },
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
    await adopted
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
  try {
    const host = await startHost(loadConfig(process.env))
    const shutdown = () => {
      host
        .stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          process.stderr.write(`${String(error)}\n`)
          process.exit(1)
        })
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
