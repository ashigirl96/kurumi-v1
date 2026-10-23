import type { ListedContainer } from './driver/docker.ts'

export type ContainerRow = {
  id: string
  sessionId: string
  status: 'starting' | 'running' | 'stopping'
  sessionActive: boolean
  owned: boolean
  startedAt: number
  lastSeenAt: number | null
  toolDeadlineAt: number | null
}

export type Reconciliation =
  | { kind: 'adopt'; row: ContainerRow; container: ListedContainer; reason: string }
  | { kind: 'reap'; row: ContainerRow; container: ListedContainer | null; reason: string }
  | { kind: 'stop'; container: ListedContainer; reason: string }

function isStale(row: ContainerRow, now: number, staleAfterMs: number): boolean {
  return (
    row.status === 'running' &&
    now - (row.lastSeenAt ?? row.startedAt) > staleAfterMs &&
    (row.toolDeadlineAt === null || now > row.toolDeadlineAt)
  )
}

function unadoptable(row: ContainerRow, container: ListedContainer): string | null {
  if (container.sessionId !== row.sessionId) return 'labels disagree with the row'
  if (!row.sessionActive) return 'session closed'
  if (container.state !== 'running') return 'container not running'
  return null
}

const unclaimedReason: Record<string, string> = { agent: 'no live row', probe: 'leftover probe' }

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
  const unclaimed = new Map<string, ListedContainer>()
  for (const container of containers ?? [])
    if (container.role === 'agent' && !unclaimed.has(container.containerId))
      unclaimed.set(container.containerId, container)
  const claimed = new Set<ListedContainer>()
  const decisions: Reconciliation[] = []
  for (const row of rows) {
    const container = unclaimed.get(row.id)
    unclaimed.delete(row.id)
    if (container) claimed.add(container)
    if (row.status === 'stopping') continue
    if (row.owned) {
      if (isStale(row, now, staleAfterMs))
        decisions.push({ kind: 'reap', row, container: container ?? null, reason: 'stale' })
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
    if (!claimed.has(container))
      decisions.push({
        kind: 'stop',
        container,
        reason: unclaimedReason[container.role] ?? 'unknown role',
      })
  return decisions
}
