import { expect, test } from 'bun:test'

import type { ListedContainer } from './driver/docker.ts'
import { planReconciliation, type ContainerRow } from './reconcile.ts'

const now = 1_000_000
const staleAfterMs = 30_000

function row(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: 'ctr-a',
    name: 'kurumi-agent-a',
    sessionId: 'ses-a',
    status: 'running',
    sessionActive: true,
    liveness: null,
    ...overrides,
  }
}

function live(lastCall: number | null, since = now - 1_000, toolDeadline: number | null = null) {
  return { since, lastCall, toolDeadline }
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

const adopt = { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' } as const

test('a running container whose live row survived the restart is adopted', () => {
  expect(plan([row()], [listed()])).toEqual([adopt])
  expect(plan([row({ status: 'starting' })], [listed()])).toEqual([adopt])
})

test('containers without a live row are stopped whatever their role', () => {
  expect(
    plan(
      [],
      [
        listed(),
        listed({ name: 'kurumi-probe-1', role: 'probe', sessionId: null, containerId: null }),
        listed({ name: 'hand-made', role: null, sessionId: null, containerId: null }),
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
  for (const labels of [{ sessionId: 'ses-other' }, { containerId: 'ctr-other' }, { role: null }])
    expect(plan([row()], [listed(labels)])).toEqual([
      { kind: 'reap', row: 'ctr-a', reason: 'labels disagree with the row' },
    ])
})

test('a row claims the container with its own name and a stray wearing its labels is stopped', () => {
  expect(plan([row()], [listed({ name: 'kurumi-stray' }), listed()])).toEqual([
    adopt,
    { kind: 'stop', name: 'kurumi-stray', reason: 'no live row' },
  ])
})

test('rows this host supervises are left to the driver unless they are stale', () => {
  expect(plan([row({ liveness: live(now) })], [])).toEqual([])
  expect(plan([row({ liveness: live(now), status: 'starting' })], [])).toEqual([])
  expect(plan([row({ liveness: live(now) })], [listed({ state: 'exited' })])).toEqual([])
})

test('a supervised running container is stale once its last channel call is older than the limit', () => {
  const stale = { kind: 'reap', row: 'ctr-a', reason: 'stale' } as const
  expect(plan([row({ liveness: live(now - staleAfterMs) })], [listed()])).toEqual([])
  expect(plan([row({ liveness: live(now - staleAfterMs - 1) })], [listed()])).toEqual([stale])
  expect(plan([row({ liveness: live(now - staleAfterMs - 1) })], null)).toEqual([stale])
  expect(
    plan([row({ liveness: live(now - staleAfterMs - 1, now - 99_000, now + 1) })], [listed()]),
  ).toEqual([])
  expect(
    plan([row({ liveness: live(now - staleAfterMs - 1, now - 99_000, now - 1) })], [listed()]),
  ).toEqual([stale])
  expect(
    plan([row({ status: 'starting', liveness: live(now - 10 * staleAfterMs) })], null),
  ).toEqual([])
})

test('a started or adopted container that never calls is reaped after the shorter of the limit and 60 s', () => {
  const silent = { kind: 'reap', row: 'ctr-a', reason: 'no channel call since start' } as const
  expect(plan([row({ liveness: live(null, now - staleAfterMs) })], [listed()])).toEqual([])
  expect(plan([row({ liveness: live(null, now - staleAfterMs - 1) })], [listed()])).toEqual([
    silent,
  ])
  const long = (rows: ContainerRow[]) =>
    planReconciliation({ rows, containers: null, now, staleAfterMs: 600_000 }).map(
      (decision) => decision.reason,
    )
  expect(long([row({ liveness: live(null, now - 60_000) })])).toEqual([])
  expect(long([row({ liveness: live(null, now - 60_001) })])).toEqual([
    'no channel call since start',
  ])
})

test('stopping rows keep their container for the cleanup that is already under way', () => {
  expect(plan([row({ status: 'stopping' })], [listed()])).toEqual([])
  expect(plan([row({ status: 'stopping', liveness: live(now - 10 * staleAfterMs) })], [])).toEqual(
    [],
  )
})

test('without a listing only staleness is judged and unadopted rows wait', () => {
  expect(plan([row()], null)).toEqual([])
})

test('each row claims at most one container and unclaimed ones are stopped', () => {
  expect(
    plan(
      [row(), row({ id: 'ctr-b', name: 'kurumi-agent-b', sessionId: 'ses-b' })],
      [
        listed(),
        listed({ name: 'kurumi-agent-b', sessionId: 'ses-b', containerId: 'ctr-b' }),
        listed({ name: 'kurumi-agent-c', sessionId: 'ses-c', containerId: 'ctr-c' }),
      ],
    ),
  ).toEqual([
    adopt,
    { kind: 'adopt', row: 'ctr-b', reason: 'running container matches its row' },
    { kind: 'stop', name: 'kurumi-agent-c', reason: 'no live row' },
  ])
})
