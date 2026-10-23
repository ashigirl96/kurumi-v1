import type { ContainerInventory, InventoryChange, ListedContainer } from './driver/docker.ts'

export type Liveness = { since: number; lastCall: number | null; toolDeadline: number | null }
export type ContainerRow = {
  id: string
  name: string
  sessionId: string
  status: 'starting' | 'running' | 'stopping'
  sessionActive: boolean
  liveness: Liveness | null
}

export type Reconciliation =
  | { kind: 'adopt'; row: ContainerRow; container: ListedContainer; reason: string }
  | { kind: 'reap'; row: ContainerRow; container: ListedContainer | null; reason: string }
  | { kind: 'stop'; container: ListedContainer; reason: string }

export type SupervisionLog =
  | {
      kind: 'session.container.adopted' | 'session.container.stopped'
      sessionId: string | null
      containerId: string | null
      name: string
      reason: string
      monotonicMs: number
    }
  | {
      kind: 'session.adoption.done'
      adopted: number
      reaped: number
      stopped: number
      monotonicMs: number
    }
  | { kind: 'session.reconcile.failed'; reason: string; monotonicMs: number }
  | { kind: 'session.events.subscribed'; attempt: number; monotonicMs: number }
  | { kind: 'session.events.lost'; code: number | null; retryMs: number; monotonicMs: number }

const firstCallGraceMs = 60_000

function staleness(liveness: Liveness, now: number, staleAfterMs: number): string | null {
  if (liveness.lastCall === null)
    return now - liveness.since > Math.min(staleAfterMs, firstCallGraceMs)
      ? 'no channel call since start'
      : null
  if (liveness.toolDeadline !== null && now <= liveness.toolDeadline) return null
  return now - liveness.lastCall > staleAfterMs ? 'stale' : null
}

function unadoptable(row: ContainerRow, container: ListedContainer): string | null {
  if (
    container.role !== 'agent' ||
    container.containerId !== row.id ||
    container.sessionId !== row.sessionId
  )
    return 'labels disagree with the row'
  if (!row.sessionActive) return 'session closed'
  if (container.state !== 'running') return 'container not running'
  return null
}

function leftover(role: ListedContainer['role']): string {
  switch (role) {
    case 'agent':
      return 'no live row'
    case 'probe':
      return 'leftover probe'
    case null:
      return 'unknown role'
    default: {
      const unknown: never = role
      return unknown
    }
  }
}

export function planReconciliation({
  rows,
  containers,
  now,
  staleAfterMs,
}: {
  rows: readonly ContainerRow[]
  containers: readonly ListedContainer[] | null
  now: number
  staleAfterMs: number
}): Reconciliation[] {
  const byName = new Map(containers?.map((container) => [container.name, container]))
  const claimed = new Set<string>()
  const decisions: Reconciliation[] = []
  for (const row of rows) {
    const container = byName.get(row.name)
    if (container) claimed.add(container.name)
    if (row.status === 'stopping') continue
    if (row.liveness) {
      const reason = row.status === 'running' ? staleness(row.liveness, now, staleAfterMs) : null
      if (reason !== null)
        decisions.push({ kind: 'reap', row, container: container ?? null, reason })
      continue
    }
    if (!containers) continue
    if (!container) {
      decisions.push({ kind: 'reap', row, container: null, reason: 'container missing' })
      continue
    }
    const reason = unadoptable(row, container)
    decisions.push(
      reason === null
        ? { kind: 'adopt', row, container, reason: 'running container matches its row' }
        : { kind: 'reap', row, container, reason },
    )
  }
  for (const container of containers ?? [])
    if (!claimed.has(container.name))
      decisions.push({ kind: 'stop', container, reason: leftover(container.role) })
  return decisions
}

export function createSupervisor(deps: {
  inventory: ContainerInventory
  staleAfterMs: number
  intervalMs: number
  rows(): ContainerRow[]
  accept(row: ContainerRow): void
  reap(rowId: string, reason: string, name: string): void
  restartClocks(): void
  log(entry: SupervisionLog): void
}) {
  const { inventory, staleAfterMs, intervalMs } = deps
  const adopted = Promise.withResolvers<void>()
  adopted.promise.catch(() => {})
  let listed = false
  let stopped = false
  let passing: Promise<void> | undefined
  let again = false
  let lastPassEnd: number | undefined
  let retryMs = 250
  let retry: ReturnType<typeof setTimeout> | undefined
  let sweeper: ReturnType<typeof setInterval> | undefined
  let unwatch: (() => void) | undefined
  const failed = (reason: string) =>
    deps.log({ kind: 'session.reconcile.failed', reason, monotonicMs: performance.now() })

  function apply(decision: Reconciliation): Reconciliation['kind'] {
    switch (decision.kind) {
      case 'adopt': {
        const { row, container } = decision
        const result = inventory.adopt(container)
        if (!result.ok) {
          deps.reap(row.id, `adoption failed: ${result.reason}`, row.name)
          return 'reap'
        }
        deps.accept(row)
        deps.log({
          kind: 'session.container.adopted',
          sessionId: row.sessionId,
          containerId: row.id,
          name: row.name,
          reason: decision.reason,
          monotonicMs: performance.now(),
        })
        return 'adopt'
      }
      case 'reap':
        deps.reap(decision.row.id, decision.reason, decision.row.name)
        return 'reap'
      case 'stop': {
        const { container, reason } = decision
        inventory.remove(container.name).then(
          () =>
            deps.log({
              kind: 'session.container.stopped',
              sessionId: container.sessionId,
              containerId: container.containerId,
              name: container.name,
              reason,
              monotonicMs: performance.now(),
            }),
          (cause: unknown) => failed(`remove ${container.name}: ${String(cause)}`),
        )
        return 'stop'
      }
      default: {
        const unknown: never = decision
        return unknown
      }
    }
  }

  async function pass(): Promise<void> {
    if (lastPassEnd !== undefined && Date.now() - lastPassEnd > 3 * intervalMs) deps.restartClocks()
    let containers: ListedContainer[] | null = null
    try {
      containers = await inventory.sweep()
    } catch (cause) {
      failed(String(cause))
    }
    if (stopped) return
    const counts = { adopt: 0, reap: 0, stop: 0 }
    for (const decision of planReconciliation({
      rows: deps.rows(),
      containers,
      now: performance.now(),
      staleAfterMs,
    }))
      counts[apply(decision)]++
    lastPassEnd = Date.now()
    if (listed) return
    if (containers) {
      listed = true
      deps.log({
        kind: 'session.adoption.done',
        adopted: counts.adopt,
        reaped: counts.reap,
        stopped: counts.stop,
        monotonicMs: performance.now(),
      })
      adopted.resolve()
      return
    }
    retry = setTimeout(request, retryMs)
    retry.unref()
    retryMs = Math.min(retryMs * 2, intervalMs)
  }

  function request(): void {
    if (stopped) return
    if (passing) {
      again = true
      return
    }
    passing = pass()
      .catch((cause: unknown) => failed(String(cause)))
      .finally(() => {
        passing = undefined
        if (again) {
          again = false
          request()
        }
      })
  }

  function observe(change: InventoryChange) {
    if (stopped) return
    const monotonicMs = performance.now()
    switch (change.kind) {
      case 'event':
        request()
        return
      case 'lost':
        deps.log({
          kind: 'session.events.lost',
          code: change.code,
          retryMs: change.retryMs,
          monotonicMs,
        })
        return
      case 'subscribed':
        deps.log({ kind: 'session.events.subscribed', attempt: change.attempt, monotonicMs })
        if (change.attempt > 0) request()
        return
      default: {
        const unknown: never = change
        return unknown
      }
    }
  }

  return {
    adopted: adopted.promise,
    async start() {
      request()
      await passing
      if (stopped) return
      unwatch = inventory.watch(observe)
      sweeper = setInterval(request, intervalMs)
      sweeper.unref()
    },
    stop(): Promise<void> {
      stopped = true
      clearTimeout(retry)
      clearInterval(sweeper)
      unwatch?.()
      adopted.reject(new Error('session supervision stopped'))
      return passing ?? Promise.resolve()
    },
  }
}
