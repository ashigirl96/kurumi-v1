import { Database } from 'bun:sqlite'

import type { Caller } from '@kurumi/rpc/contract'
import type { KurumiContext } from '@kurumi/rpc/server'
import type { AnyContractRouter } from '@orpc/contract'
import { ORPCError, type Router } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

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

export function queryReadOnly(sqlite: Database, sql: string): Record<string, unknown>[] {
  // Preparing a PRAGMA can change connection settings before execution, so diagnostics use a snapshot.
  const image = sqlite.serialize()
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
