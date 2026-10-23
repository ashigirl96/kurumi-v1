import { expect, test } from 'bun:test'

import type { ListedContainer } from './driver/docker.ts'
import { planReconciliation, type ContainerRow } from './reconcile.ts'

const now = Date.parse('2026-10-23T12:00:00Z')
const staleAfterMs = 30_000

function row(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: 'ctr-a',
    sessionId: 'ses-a',
    status: 'running',
    sessionActive: true,
    owned: false,
    startedAt: now - 60_000,
    lastSeenAt: now - 1_000,
    toolDeadlineAt: null,
    ...overrides,
  }
}

function listed(overrides: Partial<ListedContainer> = {}): ListedContainer {
  return {
    name: 'kurumi-agent-a',
    role: 'agent',
    sessionId: 'ses-a',
    containerId: 'ctr-a',
    state: 'running',
    ...overrides,
  }
}

function plan(rows: ContainerRow[], containers: ListedContainer[] | null) {
  return planReconciliation({ rows, containers, now, staleAfterMs }).map((decision) =>
    decision.kind === 'stop'
      ? { kind: decision.kind, name: decision.container.name, reason: decision.reason }
      : { kind: decision.kind, row: decision.row.id, reason: decision.reason },
  )
}

test('a running container whose live row survived the restart is adopted', () => {
  expect(plan([row()], [listed()])).toEqual([
    { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' },
  ])
  expect(plan([row({ status: 'starting' })], [listed()])).toEqual([
    { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' },
  ])
})

test('containers without a live row are stopped whatever their role', () => {
  expect(
    plan(
      [],
      [
        listed(),
        listed({ name: 'kurumi-probe-1', role: 'probe', sessionId: '', containerId: '' }),
        listed({ name: 'hand-made', role: '', sessionId: '', containerId: '' }),
      ],
    ),
  ).toEqual([
    { kind: 'stop', name: 'kurumi-agent-a', reason: 'no live row' },
    { kind: 'stop', name: 'kurumi-probe-1', reason: 'leftover probe' },
    { kind: 'stop', name: 'hand-made', reason: 'unknown role' },
  ])
})

test('a row from an earlier host is reaped when its container is gone or unusable', () => {
  expect(plan([row()], [])).toEqual([{ kind: 'reap', row: 'ctr-a', reason: 'container missing' }])
  for (const state of ['exited', 'created', 'paused', 'dead', 'restarting', 'removing'])
    expect(plan([row()], [listed({ state })])).toEqual([
      { kind: 'reap', row: 'ctr-a', reason: 'container not running' },
    ])
  expect(plan([row({ sessionActive: false })], [listed()])).toEqual([
    { kind: 'reap', row: 'ctr-a', reason: 'session closed' },
  ])
  expect(plan([row()], [listed({ sessionId: 'ses-other' })])).toEqual([
    { kind: 'reap', row: 'ctr-a', reason: 'labels disagree with the row' },
  ])
})

test('rows this host supervises are left to the driver unless they are stale', () => {
  expect(plan([row({ owned: true })], [])).toEqual([])
  expect(plan([row({ owned: true, status: 'starting' })], [])).toEqual([])
  expect(plan([row({ owned: true })], [listed({ state: 'exited' })])).toEqual([])
})

test('an owned running container is stale once its last sign of life is older than the limit', () => {
  const stale = { kind: 'reap', row: 'ctr-a', reason: 'stale' } as const
  expect(plan([row({ owned: true, lastSeenAt: now - staleAfterMs })], [listed()])).toEqual([])
  expect(plan([row({ owned: true, lastSeenAt: now - staleAfterMs - 1 })], [listed()])).toEqual([
    stale,
  ])
  expect(
    plan([row({ owned: true, lastSeenAt: null, startedAt: now - staleAfterMs - 1 })], null),
  ).toEqual([stale])
  expect(
    plan([row({ owned: true, lastSeenAt: null, startedAt: now - staleAfterMs })], null),
  ).toEqual([])
  expect(
    plan(
      [row({ owned: true, lastSeenAt: now - staleAfterMs - 1, toolDeadlineAt: now + 1 })],
      [listed()],
    ),
  ).toEqual([])
  expect(
    plan(
      [row({ owned: true, lastSeenAt: now - staleAfterMs - 1, toolDeadlineAt: now - 1 })],
      [listed()],
    ),
  ).toEqual([stale])
  expect(
    plan([row({ owned: true, status: 'starting', lastSeenAt: now - 10 * staleAfterMs })], null),
  ).toEqual([])
  expect(plan([row({ lastSeenAt: now - 10 * staleAfterMs })], [listed()])).toEqual([
    { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' },
  ])
})

test('stopping rows keep their container for the cleanup that is already under way', () => {
  expect(plan([row({ status: 'stopping' })], [listed()])).toEqual([])
  expect(plan([row({ status: 'stopping', owned: true })], [])).toEqual([])
})

test('without a listing only staleness is judged and unadopted rows wait', () => {
  expect(plan([row()], null)).toEqual([])
  expect(plan([row({ owned: true, lastSeenAt: now - staleAfterMs - 1 })], null)).toEqual([
    { kind: 'reap', row: 'ctr-a', reason: 'stale' },
  ])
})

test('each container is claimed by at most one row and the rest are stopped', () => {
  expect(
    plan(
      [row(), row({ id: 'ctr-b', sessionId: 'ses-b' })],
      [
        listed(),
        listed({ name: 'kurumi-agent-a2' }),
        listed({ name: 'kurumi-agent-b', sessionId: 'ses-b', containerId: 'ctr-b' }),
      ],
    ),
  ).toEqual([
    { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' },
    { kind: 'adopt', row: 'ctr-b', reason: 'running container matches its row' },
    { kind: 'stop', name: 'kurumi-agent-a2', reason: 'no live row' },
  ])
})
