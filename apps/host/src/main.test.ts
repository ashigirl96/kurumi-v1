import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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

function spawnHost(home: string): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, main], {
    env: { ...process.env, KURUMI_HOME: home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(child)
  return child
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
