import { expect, test } from 'bun:test'

import type { ContainerInventory, InventoryChange, ListedContainer } from './driver/docker.ts'
import {
  createLiveness,
  createSupervisor,
  planReconciliation,
  type ContainerRow,
  type SupervisionLog,
} from './reconcile.ts'

const staleAfterMs = 30_000
const revision = 'rev-1'

function row(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: 'ctr-a',
    name: 'kurumi-agent-a',
    sessionId: 'ses-a',
    status: 'running',
    sessionActive: true,
    toolDeadlineAt: null,
    liveness: null,
    ...overrides,
  }
}

function listed(overrides: Partial<ListedContainer> = {}): ListedContainer {
  return {
    name: 'kurumi-agent-a',
    role: 'agent',
    sessionId: 'ses-a',
    containerId: 'ctr-a',
    revision,
    state: 'running',
    ...overrides,
  }
}

function plan(rows: ContainerRow[], containers: ListedContainer[] | null) {
  return planReconciliation({ rows, containers, staleAfterMs, revision }).map((decision) =>
    decision.kind === 'stop'
      ? { kind: decision.kind, name: decision.container.name, reason: decision.reason }
      : { kind: decision.kind, row: decision.row.id, reason: decision.reason },
  )
}

const adopt = { kind: 'adopt', row: 'ctr-a', reason: 'running container matches its row' } as const
const silent = (silentMs: number, toolPending = false) => ({ silentMs, toolPending })

test('a running container whose live row survived the restart is adopted', () => {
  expect(plan([row()], [listed()])).toEqual([adopt])
  expect(plan([row({ status: 'starting' })], [listed()])).toEqual([adopt])
})

test('containers without a live row are stopped whatever their role', () => {
  const bare = { sessionId: null, containerId: null, revision: null }
  expect(
    plan(
      [],
      [
        listed(),
        listed({ name: 'kurumi-probe-1', role: 'probe', ...bare }),
        listed({ name: 'hand-made', role: null, ...bare }),
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
  for (const other of ['rev-0', null])
    expect(plan([row()], [listed({ revision: other })])).toEqual([
      { kind: 'reap', row: 'ctr-a', reason: 'created for another runtime' },
    ])
})

test('a row claims the container with its own name and a stray wearing its labels is stopped', () => {
  expect(plan([row()], [listed({ name: 'kurumi-stray' }), listed()])).toEqual([
    adopt,
    { kind: 'stop', name: 'kurumi-stray', reason: 'no live row' },
  ])
})

test('rows this host supervises are left to the driver unless they are stale', () => {
  expect(plan([row({ liveness: silent(0) })], [])).toEqual([])
  expect(plan([row({ liveness: silent(0), status: 'starting' })], [])).toEqual([])
  expect(plan([row({ liveness: silent(0) })], [listed({ state: 'exited' })])).toEqual([])
})

test('a supervised running container is stale once it has been silent longer than the limit', () => {
  const stale = { kind: 'reap', row: 'ctr-a', reason: 'stale' } as const
  expect(plan([row({ liveness: silent(staleAfterMs) })], [listed()])).toEqual([])
  expect(plan([row({ liveness: silent(staleAfterMs + 1) })], [listed()])).toEqual([stale])
  expect(plan([row({ liveness: silent(staleAfterMs + 1) })], null)).toEqual([stale])
  expect(plan([row({ liveness: silent(10 * staleAfterMs, true) })], [listed()])).toEqual([])
  expect(plan([row({ status: 'starting', liveness: silent(10 * staleAfterMs) })], null)).toEqual([])
})

test('stopping rows keep their container for the cleanup that is already under way', () => {
  expect(plan([row({ status: 'stopping' })], [listed()])).toEqual([])
  expect(plan([row({ status: 'stopping', liveness: silent(10 * staleAfterMs) })], [])).toEqual([])
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

function fakeClock() {
  let now = 0
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

test('silence counts only the time the host was running, one gap at most a few intervals', () => {
  const clock = fakeClock()
  const liveness = createLiveness({ maxStepMs: 30, now: clock.now })
  liveness.begin('ctr-a')
  clock.advance(20)
  expect(liveness.view('ctr-a')).toEqual({ silentMs: 20, toolPending: false })
  clock.advance(600_000)
  expect(liveness.view('ctr-a')).toEqual({ silentMs: 50, toolPending: false })
  liveness.touch('ctr-a')
  clock.advance(10)
  expect(liveness.view('ctr-a')?.silentMs).toBe(10)
})

test('a host that stalls again and again still accumulates the silence it was awake for', () => {
  const clock = fakeClock()
  const liveness = createLiveness({ maxStepMs: 30, now: clock.now })
  liveness.begin('ctr-a')
  for (let round = 0; round < 10; round++) {
    clock.advance(500)
    liveness.view('ctr-a')
    clock.advance(10)
    liveness.view('ctr-a')
    clock.advance(10)
    liveness.view('ctr-a')
  }
  expect(liveness.view('ctr-a')?.silentMs).toBe(10 * (30 + 20))
})

test('a declared tool deadline keeps a silent container alive until it passes', () => {
  const clock = fakeClock()
  const liveness = createLiveness({ maxStepMs: 1_000, now: clock.now })
  liveness.begin('ctr-a', 500)
  clock.advance(400)
  expect(liveness.view('ctr-a')).toEqual({ silentMs: 400, toolPending: true })
  clock.advance(200)
  expect(liveness.view('ctr-a')).toEqual({ silentMs: 600, toolPending: false })
  liveness.declareTool('ctr-a', 1_000)
  clock.advance(900)
  expect(liveness.view('ctr-a')?.toolPending).toBe(true)
  liveness.declareTool('ctr-a', null)
  expect(liveness.view('ctr-a')?.toolPending).toBe(false)
  liveness.end('ctr-a')
  expect(liveness.has('ctr-a')).toBe(false)
  expect(liveness.view('ctr-a')).toBeNull()
})

function fakeInventory() {
  const sweeps: number[] = []
  let failing = true
  let watcher: ((change: InventoryChange) => void) | undefined
  const inventory: ContainerInventory = {
    async sweep() {
      sweeps.push(performance.now())
      if (failing) throw new Error('Cannot connect to the Docker daemon')
      return []
    },
    adopt: () => ({ ok: true }),
    remove: async () => {},
    nameOf: (id) => `kurumi-agent-${id}`,
    watch(listener) {
      watcher = listener
      return () => {
        watcher = undefined
      }
    },
  }
  return {
    inventory,
    sweeps,
    answer() {
      failing = false
    },
    emit: (change: InventoryChange) => watcher?.(change),
    watched: () => watcher !== undefined,
  }
}

function supervise(inventory: ContainerInventory, intervalMs: number) {
  const logs: SupervisionLog[] = []
  const supervisor = createSupervisor({
    inventory,
    staleAfterMs,
    intervalMs,
    revision,
    rows: () => [],
    accept: () => {},
    reap: () => {},
    log: (entry) => logs.push(entry),
  })
  return { supervisor, logs }
}

test('while Docker cannot be listed the supervisor retries with backoff and adoption waits', async () => {
  const fake = fakeInventory()
  const { supervisor, logs } = supervise(fake.inventory, 400)
  let adopted = false
  supervisor.adopted.then(
    () => {
      adopted = true
    },
    () => {},
  )
  await supervisor.start()
  expect(fake.watched()).toBe(true)
  await Bun.sleep(1_900)
  expect(adopted).toBe(false)
  expect(fake.sweeps.length).toBeGreaterThanOrEqual(5)
  expect(fake.sweeps.length).toBeLessThanOrEqual(7)
  fake.answer()
  await Bun.sleep(450)
  expect(adopted).toBe(true)
  expect(logs.filter((entry) => entry.kind === 'session.adoption.done')).toHaveLength(1)
  await supervisor.stop()
})

test('an event or a resubscription wakes the supervisor before its interval', async () => {
  const fake = fakeInventory()
  fake.answer()
  const { supervisor } = supervise(fake.inventory, 60_000)
  await supervisor.start()
  await supervisor.adopted
  expect(fake.sweeps).toHaveLength(1)
  fake.emit({ kind: 'event' })
  fake.emit({ kind: 'event' })
  await Bun.sleep(10)
  expect(fake.sweeps).toHaveLength(2)
  fake.emit({ kind: 'subscribed', attempt: 0 })
  await Bun.sleep(10)
  expect(fake.sweeps).toHaveLength(2)
  fake.emit({ kind: 'subscribed', attempt: 1 })
  await Bun.sleep(10)
  expect(fake.sweeps).toHaveLength(3)
  await supervisor.stop()
})

test('stopping before any listing answered rejects adoption and ends the loop', async () => {
  const fake = fakeInventory()
  const { supervisor, logs } = supervise(fake.inventory, 60_000)
  await supervisor.start()
  const adopted = supervisor.adopted.then(
    () => 'adopted',
    (error: unknown) => String(error),
  )
  await supervisor.stop()
  expect(await adopted).toContain('stopped')
  expect(fake.watched()).toBe(false)
  const sweeps = fake.sweeps.length
  await Bun.sleep(600)
  expect(fake.sweeps).toHaveLength(sweeps)
  expect(logs.filter((entry) => entry.kind === 'session.adoption.done')).toHaveLength(0)
})
