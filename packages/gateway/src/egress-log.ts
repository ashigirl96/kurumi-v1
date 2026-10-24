import { transaction, type Db } from '@kurumi/rpc/server'
import { and, desc, eq, getTableColumns, lt, type SQL } from 'drizzle-orm'

import type { EgressLogFilter, EgressLogRow } from './contract.ts'
import type { EgressEvent } from './forward.ts'
import { egressLog } from './schema.ts'

export type EgressPrincipal = { agentGroupId: string; sessionId: string }

export type EgressLogEvent = {
  kind: 'gateway.egress_log.write_failed'
  operation: 'flush' | 'prune'
  rows: number
  message: string
}

export type EgressLog = {
  record(this: void, event: EgressEvent<EgressPrincipal>): void
  rows(filter: EgressLogFilter): EgressLogRow[]
  stop(): void
}

const DAY_MS = 24 * 60 * 60 * 1000
// 13 bound values per row stays under SQLite's 32766 host-parameter limit.
const ROWS_PER_INSERT = 500

function rowOf(event: EgressEvent<EgressPrincipal>): typeof egressLog.$inferInsert {
  const row = {
    at: new Date(event.at),
    agentGroupId: event.principal.agentGroupId,
    sessionId: event.principal.sessionId,
    host: event.host,
    method: event.method,
    path: event.path,
    status: event.status,
    durationMs: event.durationMs,
  }
  switch (event.decision) {
    case 'injected':
      return { ...row, decision: 'injected', account: event.account, service: event.service }
    case 'passed':
      return { ...row, decision: 'passed' }
    case 'refused':
      return { ...row, decision: 'refused', refusal: event.refusal, service: event.service }
    case 'held':
      return { ...row, decision: 'held', service: event.service }
    default: {
      const unknown: never = event
      return unknown
    }
  }
}

export function createEgressLog(deps: {
  db: Db
  log(event: EgressLogEvent): void
  now?: () => number
  flushMs?: number
  pruneEveryMs?: number
  retainMs?: number
}): EgressLog {
  const now = deps.now ?? Date.now
  const flushMs = deps.flushMs ?? 1_000
  const retainMs = deps.retainMs ?? 30 * DAY_MS
  let pending: (typeof egressLog.$inferInsert)[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const failed = (operation: EgressLogEvent['operation'], rows: number, error: unknown) =>
    deps.log({
      kind: 'gateway.egress_log.write_failed',
      operation,
      rows,
      message: error instanceof Error ? error.message : String(error),
    })

  function flush(): void {
    clearTimeout(flushTimer)
    flushTimer = undefined
    const batch = pending
    if (batch.length === 0) return
    pending = []
    try {
      transaction(deps.db, (tx) => {
        for (let start = 0; start < batch.length; start += ROWS_PER_INSERT) {
          tx.insert(egressLog)
            .values(batch.slice(start, start + ROWS_PER_INSERT))
            .run()
        }
      })
    } catch (error) {
      failed('flush', batch.length, error)
    }
  }

  function prune(): void {
    try {
      deps.db
        .delete(egressLog)
        .where(lt(egressLog.at, new Date(now() - retainMs)))
        .run()
    } catch (error) {
      failed('prune', 0, error)
    }
  }

  prune()
  const pruneTimer = setInterval(prune, deps.pruneEveryMs ?? 60 * 60 * 1000)

  return {
    record(event) {
      if (stopped) return
      pending.push(rowOf(event))
      flushTimer ??= setTimeout(flush, flushMs)
    },
    rows({ agentGroupId, account, decision, limit }) {
      flush()
      const conditions: SQL[] = []
      if (agentGroupId !== undefined) conditions.push(eq(egressLog.agentGroupId, agentGroupId))
      if (account !== undefined) conditions.push(eq(egressLog.account, account))
      if (decision !== undefined) conditions.push(eq(egressLog.decision, decision))
      const { id: _id, ...columns } = getTableColumns(egressLog)
      return deps.db
        .select(columns)
        .from(egressLog)
        .where(and(...conditions))
        .orderBy(desc(egressLog.at), desc(egressLog.id))
        .limit(limit)
        .all()
        .toReversed()
    },
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(pruneTimer)
      flush()
    },
  }
}
