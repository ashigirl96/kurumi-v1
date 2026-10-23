import { Database } from 'bun:sqlite'
import { deserialize, serialize } from 'node:v8'

import type { Caller } from '@kurumi/rpc/contract'
import type { KurumiContext } from '@kurumi/rpc/server'
import type { AnyContractRouter } from '@orpc/contract'
import { ORPCError, type Router } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { z } from 'zod'

export function createRpcFronts<TContext extends KurumiContext>(
  router: Router<AnyContractRouter, TContext>,
  contextFor: (caller: Caller) => TContext,
) {
  const handler = new RPCHandler(router)
  return {
    host: async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname === '/health') return new Response('ready')
      const result = await handler.handle(request, {
        prefix: '/rpc',
        context: contextFor({ kind: 'host' }),
      })
      return result.matched ? result.response : new Response('Not found', { status: 404 })
    },
  }
}

const queryReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rows'), rows: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ kind: z.literal('forbidden'), message: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])

export function queryReadOnly(sqlite: Database, sql: string): Record<string, unknown>[] {
  const child = Bun.spawnSync([process.execPath, import.meta.path, sql], {
    stdin: sqlite.serialize(),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 1000,
    killSignal: 'SIGKILL',
  })
  if (!child.success) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Diagnostic SQL worker failed' })
  }
  const reply = queryReply.parse(deserialize(child.stdout))
  switch (reply.kind) {
    case 'rows':
      return reply.rows
    case 'forbidden':
      throw new ORPCError('FORBIDDEN', { message: reply.message })
    case 'error':
      throw new ORPCError('BAD_REQUEST', { message: reply.message })
  }
}

function querySnapshot(image: Uint8Array, sql: string): Record<string, unknown>[] {
  // SQLite deserialize needs rollback-journal header bytes, even for a snapshot of a WAL database.
  image[18] = 1
  image[19] = 1
  using snapshot = Database.deserialize(image, { readonly: true })
  using statement = snapshot.prepare<Record<string, unknown>, []>(sql)
  if (statement.columnNames.length === 0) {
    throw new ORPCError('FORBIDDEN', {
      message: 'db query accepts only read-only statements that return rows',
    })
  }
  try {
    // Bun 1.4.3 calls sqlite3_stmt_readonly here and rejects writes before stepping the statement.
    void statement.columnTypes
  } catch (cause) {
    throw new ORPCError('FORBIDDEN', {
      message: 'db query accepts only read-only statements',
      cause,
    })
  }
  return statement.all()
}

if (import.meta.main) {
  let reply: z.infer<typeof queryReply>
  try {
    const sql = process.argv[2]
    if (sql === undefined) throw new Error('SQL is required')
    const image = new Uint8Array(await Bun.stdin.arrayBuffer())
    reply = { kind: 'rows', rows: querySnapshot(image, sql) }
  } catch (error) {
    reply = {
      kind: error instanceof ORPCError && error.code === 'FORBIDDEN' ? 'forbidden' : 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  process.stdout.write(serialize(reply))
}
