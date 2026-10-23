import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createAccountLedger } from '@kurumi/account/server'
import { createAgentLedger, router as agentRouter } from '@kurumi/agent/server'
import { hostContract, type Caller } from '@kurumi/rpc/contract'
import { guardRouter, type Guard, type KurumiContext } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'

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
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  chmodSync(config.home, 0o700)
  const releaseLock = acquireLock(join(config.home, 'kurumi.lock'))
  let database: KurumiDb | undefined
  let listener: ReturnType<typeof Bun.serve> | undefined
  try {
    const db = openKurumiDb(join(config.home, 'kurumi.db'))
    database = db
    migrateAll(db, migrations)
    const ledgers = {
      agentLedger: createAgentLedger({ db, home: config.home }),
      accountLedger: createAccountLedger({ db }),
    }
    type HostContext = KurumiContext & typeof ledgers
    const admin = implement(hostContract).$context<HostContext>()
    const router = guardRouter<HostContext>().router({
      agent: agentRouter,
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
      ...ledgers,
    })
    const rpc = createRpcFronts(router, contextFor)
    const socket = join(config.home, 'kurumi.sock')
    const stale = lstatSync(socket, { throwIfNoEntry: false })
    if (stale && !stale.isSocket()) throw new Error(`${socket} exists and is not a socket`)
    rmSync(socket, { force: true })
    const server = Bun.serve({ unix: socket, fetch: rpc.host })
    listener = server
    chmodSync(socket, 0o600)
    return {
      async stop() {
        await server.stop(true)
        rmSync(socket, { force: true })
        db.$client.close()
        releaseLock()
      },
    }
  } catch (error) {
    await listener?.stop(true)
    database?.$client.close()
    releaseLock()
    throw error
  }
}

if (import.meta.main) {
  try {
    const host = await startHost(loadConfig(process.env))
    process.once('SIGTERM', () => {
      host
        .stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          process.stderr.write(`${String(error)}\n`)
          process.exit(1)
        })
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
