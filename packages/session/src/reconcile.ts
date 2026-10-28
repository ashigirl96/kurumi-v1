import type { ContainerInventory } from './driver/docker.ts'
import type { InventoryChange } from './driver/events.ts'
import type { ListedContainer } from './driver/listing.ts'

export type LivenessView = { awakeSilentMs: number; toolPending: boolean }
export type ContainerRow = {
  id: string
  name: string
  sessionId: string
  status: 'starting' | 'running' | 'stopping'
  sessionActive: boolean
  liveness: LivenessView | null
}

export type Reconciliation =
  | { kind: 'adopt'; row: ContainerRow; container: ListedContainer; reason: string }
  | { kind: 'reap'; row: ContainerRow; reason: string }
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

function createAwakeClock(maxStepMs: number, now: () => number): () => number {
  let awake = 0
  let seen = now()
  return () => {
    const current = now()
    awake += Math.min(Math.max(0, current - seen), maxStepMs)
    seen = current
    return awake
  }
}

export function createLiveness({
  maxStepMs,
  now = () => performance.now(),
}: {
  maxStepMs: number
  now?: () => number
}) {
  const clock = createAwakeClock(maxStepMs, now)
  const entries = new Map<string, { last: number; toolDeadline: number | null }>()
  return {
    begin(id: string, toolTimeoutMs: number | null = null) {
      const at = clock()
      entries.set(id, {
        last: at,
        toolDeadline: toolTimeoutMs === null ? null : at + toolTimeoutMs,
      })
    },
    touch(id: string) {
      const entry = entries.get(id)
      if (entry) entry.last = clock()
    },
    declareTool(id: string, toolTimeoutMs: number | null) {
      const entry = entries.get(id)
      if (entry) entry.toolDeadline = toolTimeoutMs === null ? null : clock() + toolTimeoutMs
    },
    end(id: string) {
      entries.delete(id)
    },
    has(id: string) {
      return entries.has(id)
    },
    view(id: string): LivenessView | null {
      const entry = entries.get(id)
      if (!entry) return null
      const at = clock()
      return {
        awakeSilentMs: at - entry.last,
        toolPending: entry.toolDeadline !== null && at <= entry.toolDeadline,
      }
    },
  }
}

function unadoptable(row: ContainerRow, container: ListedContainer) {
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
    case 'relay':
      return 'leftover relay'
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
  staleAfterMs,
}: {
  rows: readonly ContainerRow[]
  containers: readonly ListedContainer[] | null
  staleAfterMs: number
}): Reconciliation[] {
  const byName = new Map(containers?.map((container) => [container.name, container]))
  const claimed = new Set<string>()
  const decisions: Reconciliation[] = []
  for (const row of rows) {
    const container = byName.get(row.name)
    if (container) claimed.add(container.name)
    if (row.status === 'stopping') {
      decisions.push({ kind: 'reap', row, reason: 'cleanup unfinished' })
      continue
    }
    if (row.liveness) {
      const { awakeSilentMs, toolPending } = row.liveness
      if (row.status === 'running' && !toolPending && awakeSilentMs > staleAfterMs)
        decisions.push({ kind: 'reap', row, reason: 'stale' })
      continue
    }
    if (!containers) continue
    const reason = container ? unadoptable(row, container) : 'container missing'
    if (reason !== null) decisions.push({ kind: 'reap', row, reason })
    else if (container)
      decisions.push({ kind: 'adopt', row, container, reason: 'running container matches its row' })
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
  reap(rowId: string, reason: string, name: string): Promise<void>
  log(entry: SupervisionLog): void
}) {
  const { inventory, intervalMs } = deps
  const firstPass = Promise.withResolvers<void>()
  const adopted = Promise.withResolvers<void>()
  adopted.promise.catch(() => {})
  let stopped = false
  let pokedWhileBusy = false
  let wake: (() => void) | undefined
  let loop: Promise<void> | undefined
  let unwatch: (() => void) | undefined
  const failed = (reason: string) =>
    deps.log({ kind: 'session.reconcile.failed', reason, monotonicMs: performance.now() })

  function poke() {
    if (wake) wake()
    else pokedWhileBusy = true
  }

  function pause(ms: number): Promise<void> {
    if (pokedWhileBusy || stopped) {
      pokedWhileBusy = false
      return Promise.resolve()
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, ms)
    timer.unref()
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
    return promise.finally(() => {
      wake = undefined
    })
  }

  async function apply(decision: Reconciliation): Promise<Reconciliation['kind'] | null> {
    switch (decision.kind) {
      case 'adopt': {
        const { row, container } = decision
        const result = await inventory.adopt(container)
        if (stopped) return null
        if (!result.ok) {
          await deps.reap(row.id, `adoption failed: ${result.reason}`, row.name)
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
        await deps.reap(decision.row.id, decision.reason, decision.row.name)
        return 'reap'
      case 'stop': {
        const { container, reason } = decision
        await inventory.remove(container)
        deps.log({
          kind: 'session.container.stopped',
          sessionId: container.sessionId,
          containerId: container.containerId,
          name: container.name,
          reason,
          monotonicMs: performance.now(),
        })
        return 'stop'
      }
      default: {
        const unknown: never = decision
        return unknown
      }
    }
  }

  async function run() {
    let listed = false
    let backoffMs = Math.min(250, intervalMs)
    for (;;) {
      if (stopped) break
      let containers: ListedContainer[] | null = null
      try {
        containers = await inventory.sweep()
      } catch (cause) {
        if (!stopped) failed(String(cause))
      }
      if (stopped) break
      const counts = { adopt: 0, reap: 0, stop: 0 }
      let applied = true
      let decisions: Reconciliation[] = []
      try {
        decisions = planReconciliation({
          rows: deps.rows(),
          containers,
          staleAfterMs: deps.staleAfterMs,
        })
      } catch (cause) {
        applied = false
        failed(String(cause))
      }
      for (const decision of decisions)
        try {
          if (stopped) break
          const kind = await apply(decision)
          if (kind !== null) counts[kind]++
        } catch (cause) {
          applied = false
          failed(String(cause))
        }
      if (stopped) break
      if (containers && applied && !listed) {
        listed = true
        deps.log({
          kind: 'session.adoption.done',
          adopted: counts.adopt,
          reaped: counts.reap,
          stopped: counts.stop,
          monotonicMs: performance.now(),
        })
        adopted.resolve()
      }
      firstPass.resolve()
      await pause(listed ? intervalMs : backoffMs)
      if (!listed) backoffMs = Math.min(backoffMs * 2, intervalMs)
    }
  }

  function observe(change: InventoryChange) {
    if (stopped) return
    const monotonicMs = performance.now()
    switch (change.kind) {
      case 'event':
        poke()
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
        if (change.attempt > 0) poke()
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
      loop ??= run()
        .catch((cause: unknown) => failed(String(cause)))
        .catch(() => {})
        .finally(() => firstPass.resolve())
      await firstPass.promise
      if (!stopped) unwatch = inventory.watch(observe)
    },
    stop(): Promise<void> {
      stopped = true
      unwatch?.()
      poke()
      adopted.reject(new Error('session supervision stopped'))
      return loop ?? Promise.resolve()
    },
  }
}
