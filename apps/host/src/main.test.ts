import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLedger } from '@kurumi/agent/server'

import { openKurumiDb, migrateAll } from './db.ts'
import { queryReadOnly } from './fronts.ts'
import { initialGuard } from './main.ts'
import { migrations } from './migrations.ts'

const homes: string[] = []
const children: Bun.Subprocess[] = []
const main = join(import.meta.dir, 'main.ts')

function homeForTest(): string {
  const home = mkdtempSync(join(tmpdir(), 'kurumi-host-'))
  homes.push(home)
  return home
}

function spawnHost(home: string, preload?: string): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), main], {
    env: { ...process.env, KURUMI_HOME: home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(child)
  return child
}

function probeSocketBind(home: string, fail = false): string {
  const preload = join(home, 'probe-bind.ts')
  writeFileSync(
    preload,
    `
    import { statSync, writeFileSync } from 'node:fs'
    const serve = Bun.serve
    process.umask(0o022)
    Bun.serve = (options) => {
      try {
        if (${fail}) throw new Error('forced bind failure')
        const server = serve(options)
        writeFileSync(${JSON.stringify(join(home, 'bind-mode'))}, (statSync(options.unix).mode & 0o777).toString(8))
        Bun.sleepSync(30)
        return server
      } finally {
        queueMicrotask(() => writeFileSync(${JSON.stringify(join(home, 'restored-umask'))}, process.umask().toString(8)))
      }
    }
  `,
  )
  return preload
}

async function waitForHost(home: string, child: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode} before readiness`)
    try {
      const response = await fetch('http://localhost/health', { unix: join(home, 'kurumi.sock') })
      if (response.ok) return
    } catch {}
    await Bun.sleep(20)
  }
  throw new Error('host did not become ready')
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('a second host fails at the lock and names the first pid', async () => {
  const home = homeForTest()
  const first = spawnHost(home)
  await waitForHost(home, first)
  const second = spawnHost(home)
  const error = await new Response(second.stderr).text()
  expect(await second.exited).toBe(1)
  expect(error).toContain('kurumi.lock')
  expect(error).toContain(String(first.pid))
  expect(statSync(join(home, 'kurumi.sock')).mode & 0o777).toBe(0o600)
  first.kill('SIGTERM')
  expect(await first.exited).toBe(0)
  expect(existsSync(join(home, 'kurumi.sock'))).toBe(false)
}, 5000)

test.each(['SIGTERM', 'SIGINT'] as const)(
  '%s stops the host cleanly and removes its socket',
  async (signal) => {
    const home = homeForTest()
    const host = spawnHost(home)
    await waitForHost(home, host)
    host.kill(signal)
    expect(await host.exited).toBe(0)
    expect(existsSync(join(home, 'kurumi.sock'))).toBe(false)
  },
  5000,
)

test('concurrent host starts name the lock owner before its pid write completes', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const home = homeForTest()
    const preload = join(home, 'delay-pid.ts')
    writeFileSync(
      preload,
      `
      import { mock } from 'bun:test'
      import * as fs from 'node:fs'
      const truncate = fs.ftruncateSync
      mock.module('node:fs', () => ({
        ...fs,
        ftruncateSync(fd, length) {
          truncate(fd, length)
          Bun.sleepSync(200)
        },
      }))
    `,
    )
    const started = performance.now()
    const pair = [spawnHost(home, preload), spawnHost(home, preload)]
    const exited = await Promise.race(
      pair.map(async (child) => ({ child, code: await child.exited })),
    )
    const winner = pair.find((child) => child !== exited.child)
    if (!winner) throw new Error('Expected one lock owner')
    expect(exited.code).toBe(1)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(await new Response(exited.child.stderr).text()).toContain(
      `kurumi.lock is held by host pid ${winner.pid}`,
    )
    await waitForHost(home, winner)
    winner.kill('SIGTERM')
    expect(await winner.exited).toBe(0)
  }
}, 10000)

test('the socket is mode 0600 from bind while another process polls before startup', async () => {
  const home = homeForTest()
  const poller = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { existsSync, lstatSync, writeFileSync } from 'node:fs'
    const home = ${JSON.stringify(home)}
    const modes = new Set()
    const deadline = performance.now() + 4000
    writeFileSync(home + '/polling', '')
    while (!existsSync(home + '/stop-polling') && performance.now() < deadline) {
      const stat = lstatSync(home + '/kurumi.sock', { throwIfNoEntry: false })
      if (stat) modes.add((stat.mode & 0o777).toString(8))
      Bun.sleepSync(1)
    }
    console.log([...modes].join(','))
  `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  children.push(poller)
  for (let attempt = 0; !existsSync(join(home, 'polling')); attempt++) {
    if (attempt === 100) throw new Error('socket poller did not start')
    await Bun.sleep(10)
  }
  const host = spawnHost(home, probeSocketBind(home))
  await waitForHost(home, host)
  writeFileSync(join(home, 'stop-polling'), '')
  const observed = (await new Response(poller.stdout).text()).trim()
  expect(await poller.exited).toBe(0)
  expect({ observed, bound: readFileSync(join(home, 'bind-mode'), 'utf8') }).toEqual({
    observed: '600',
    bound: '600',
  })
  expect(readFileSync(join(home, 'restored-umask'), 'utf8')).toBe('22')
  host.kill('SIGTERM')
  expect(await host.exited).toBe(0)
}, 5000)

test('a failed socket bind restores the process umask', async () => {
  const home = homeForTest()
  const host = spawnHost(home, probeSocketBind(home, true))
  expect(await host.exited).toBe(1)
  expect(await new Response(host.stderr).text()).toContain('forced bind failure')
  expect(readFileSync(join(home, 'restored-umask'), 'utf8')).toBe('22')
})

test('a killed host leaves a lock and socket that a new host can recover', async () => {
  const home = homeForTest()
  const first = spawnHost(home)
  await waitForHost(home, first)
  first.kill('SIGKILL')
  await first.exited
  const replacement = spawnHost(home)
  await waitForHost(home, replacement)
  replacement.kill('SIGTERM')
  expect(await replacement.exited).toBe(0)
  expect(existsSync(join(home, 'kurumi.sock'))).toBe(false)
}, 5000)

test('diagnostic SQL reads a WAL snapshot without writing rows or changing the host connection', () => {
  const home = homeForTest()
  const db = openKurumiDb(join(home, 'kurumi.db'))
  try {
    migrateAll(db, migrations)
    const ledger = createAgentLedger({ db, home })
    const created = ledger.create({ name: 'work' })
    expect(queryReadOnly(db.$client, 'select id, name from agent_group')).toEqual([
      { id: created.id, name: 'work' },
    ])
    for (const sql of [
      'delete from agent_group',
      "update agent_group set name = 'changed' returning name",
      "insert into agent_group values ('ag-evil', 'evil', 'evil', 0) returning id",
      'drop table agent_group',
      'begin',
      "attach database ':memory:' as other",
      'pragma foreign_keys=off',
    ]) {
      expect(() => queryReadOnly(db.$client, sql)).toThrow()
    }
    queryReadOnly(db.$client, 'pragma locking_mode=normal')
    expect(queryReadOnly(db.$client, 'select name from agent_group')).toEqual([{ name: 'work' }])
    expect(db.$client.query('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.$client.query('pragma locking_mode').get()).toEqual({ locking_mode: 'exclusive' })
    expect(db.$client.inTransaction).toBe(false)
  } finally {
    db.$client.close()
  }
})

test('diagnostic SQL cannot change the host SQLite process heap setting', () => {
  const db = openKurumiDb(join(homeForTest(), 'kurumi.db'))
  const before = db.$client.query<{ soft_heap_limit: number }, []>('pragma soft_heap_limit').get()
  if (!before) throw new Error('Expected SQLite heap setting')
  try {
    queryReadOnly(db.$client, 'pragma soft_heap_limit=100000000')
    expect(db.$client.query('pragma soft_heap_limit').get()).toEqual(before)
  } finally {
    db.$client.run(`pragma soft_heap_limit=${before.soft_heap_limit}`)
    db.$client.close()
  }
})

test('rejected diagnostic SQL cannot change the host SQLite temporary directory', () => {
  const db = openKurumiDb(join(homeForTest(), 'kurumi.db'))
  const before = db.$client.query('pragma temp_store_directory').all()
  try {
    expect(() => queryReadOnly(db.$client, "pragma temp_store_directory='/tmp'")).toThrow()
    expect(db.$client.query('pragma temp_store_directory').all()).toEqual(before)
  } finally {
    db.$client.run("pragma temp_store_directory=''")
    db.$client.close()
  }
})

test('diagnostic worker preserves blobs and reports query errors and timeout', () => {
  const db = openKurumiDb(join(homeForTest(), 'kurumi.db'))
  try {
    expect(queryReadOnly(db.$client, "select x'0001ff' as bytes")).toEqual([
      { bytes: new Uint8Array([0, 1, 255]) },
    ])
    expect(() => queryReadOnly(db.$client, 'select from')).toThrow()
    expect(() =>
      queryReadOnly(
        db.$client,
        'with recursive numbers(n) as (values(0) union all select n+1 from numbers) select sum(n) from numbers',
      ),
    ).toThrow('Diagnostic SQL worker failed')
    expect(queryReadOnly(db.$client, 'select 1 as alive')).toEqual([{ alive: 1 }])
  } finally {
    db.$client.close()
  }
}, 5000)

test('the temporary host guard allows host and human callers and only agent channel calls', () => {
  const common = { path: ['probe'], input: undefined, grant: null }
  expect(initialGuard({ ...common, caller: { kind: 'host' }, meta: {} })).toEqual({ kind: 'allow' })
  expect(
    initialGuard({ ...common, caller: { kind: 'human', userId: 'u' }, meta: { agent: 'hold' } }),
  ).toEqual({ kind: 'allow' })
  const caller = { kind: 'agent', agentGroupId: 'ag-test', sessionId: 's' } as const
  expect(initialGuard({ ...common, caller, meta: { agent: 'channel' } })).toEqual({ kind: 'allow' })
  for (const meta of [
    {},
    { agent: 'own-group' },
    { agent: 'scoped' },
    { agent: 'hold' },
  ] as const) {
    expect(initialGuard({ ...common, caller, meta }).kind).toBe('deny')
  }
})
