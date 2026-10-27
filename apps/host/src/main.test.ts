import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { randomBytes, X509Certificate } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccessLedger } from '@kurumi/access/server'
import { seal } from '@kurumi/account/server'
import { createAgentLedger } from '@kurumi/agent/server'
import { createApprovalLedger } from '@kurumi/approval/server'
import { createRouterClient } from '@orpc/server'
import { z } from 'zod'

import { openKurumiDb, migrateAll } from './db.ts'
import { queryReadOnly } from './fronts.ts'
import { hostRouter, type HostContext } from './main.ts'
import { migrations } from './migrations.ts'

const homes: string[] = []
const children: Bun.Subprocess[] = []
const main = join(import.meta.dir, 'main.ts')

function homeForTest(prefix = 'kurumi-host-'): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

function spawnHost(
  home: string,
  preload?: string,
  env: Record<string, string> = {},
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), main], {
    env: { ...process.env, KURUMI_HOME: home, ...env },
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

test('a repeated SIGINT during shutdown still lets the host stop cleanly', async () => {
  const home = homeForTest()
  const created = join(home, 'create-started')
  writeFileSync(
    join(home, 'docker'),
    `#!/bin/sh\nif [ "$1" = create ]; then : > '${created}'; sleep 1; fi\n`,
    { mode: 0o755 },
  )
  const host = spawnHost(home, undefined, { PATH: `${home}:${process.env.PATH}` })
  await waitForHost(home, host)
  for (let attempt = 0; !existsSync(created); attempt++) {
    if (attempt === 200 || host.exitCode !== null) throw new Error('fake docker create never ran')
    await Bun.sleep(10)
  }
  host.kill('SIGINT')
  await Bun.sleep(100)
  host.kill('SIGINT')
  expect(await host.exited).toBe(0)
  expect(existsSync(join(home, 'kurumi.sock'))).toBe(false)
}, 5000)

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

async function startAndStop(home: string): Promise<string> {
  const host = spawnHost(home)
  await waitForHost(home, host)
  host.kill('SIGTERM')
  expect(await host.exited).toBe(0)
  return new Response(host.stdout).text()
}

function storedCa(home: string): string | undefined {
  const sqlite = new Database(join(home, 'kurumi.db'), { readonly: true })
  try {
    return sqlite.query<{ pem: string }, []>('SELECT cert_pem AS pem FROM gateway_ca').get()?.pem
  } finally {
    sqlite.close()
  }
}

function storeAccount(home: string, material: Uint8Array): void {
  const sqlite = new Database(join(home, 'kurumi.db'))
  sqlite
    .query(
      `INSERT INTO account (id, vendor, label, kind, auth_mode, services, material, status, created_at)
       VALUES ('acc-a', 'anthropic', 'main', 'key', 'api-key', '["anthropic-api"]', ?, 'active', 0)`,
    )
    .run(material)
  sqlite.close()
}

test('a host started over egress_log rows from 31 days ago prunes them and keeps newer ones', async () => {
  const home = homeForTest()
  await startAndStop(home)
  const sqlite = new Database(join(home, 'kurumi.db'))
  const insert = sqlite.query(
    `INSERT INTO egress_log (at, agent_group_id, session_id, host, method, path, decision, status, duration_ms)
     VALUES (?, 'g1', 's1', 'api.anthropic.com', 'GET', ?, 'passed', 200, 1)`,
  )
  insert.run(Date.now() - 31 * 24 * 60 * 60 * 1000, '/old')
  insert.run(Date.now() - 29 * 24 * 60 * 60 * 1000, '/recent')
  sqlite.close()

  await startAndStop(home)

  const after = new Database(join(home, 'kurumi.db'), { readonly: true })
  expect(after.query('SELECT path FROM egress_log').all()).toEqual([{ path: '/recent' }])
  after.close()
}, 5000)

test('kurumi gateway status prints the Agent Port address and the fingerprint of the stored CA', async () => {
  const home = homeForTest()
  const host = spawnHost(home, undefined, { KURUMI_AGENT_PORT: '40059' })
  await waitForHost(home, host)
  const command = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../cli/src/main.ts'), 'gateway', 'status'],
    { env: { ...process.env, KURUMI_HOME: home }, stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await command.exited).toBe(0)
  const printed = await new Response(command.stdout).text()
  host.kill('SIGTERM')
  expect(await host.exited).toBe(0)
  const pem = storedCa(home)
  if (pem === undefined) throw new Error('no stored CA')

  expect(printed).toContain('agent port  127.0.0.1:40059')
  expect(printed).toContain(`ca sha256   ${new X509Certificate(pem).fingerprint256}`)
}, 5000)

test('with no accounts stored, a host whose vault.key was deleted starts with a new key and a new gateway CA', async () => {
  const home = homeForTest()
  await startAndStop(home)
  const before = storedCa(home)
  rmSync(join(home, 'vault.key'))

  const stdout = await startAndStop(home)

  expect(storedCa(home)).not.toBe(before)
  expect(stdout).toContain('"kind":"gateway.ca.replaced"')
}, 5000)

test('after the start-over SQL deletes every account, a host without vault.key starts with a new gateway CA', async () => {
  const home = homeForTest()
  await startAndStop(home)
  const before = storedCa(home)
  storeAccount(home, Buffer.of(0))
  rmSync(join(home, 'vault.key'))
  const refused = spawnHost(home)
  expect(await refused.exited).toBe(1)
  const startOver = Bun.spawnSync([
    'sqlite3',
    join(home, 'kurumi.db'),
    'PRAGMA foreign_keys = ON; DELETE FROM account;',
  ])
  expect(startOver.exitCode).toBe(0)

  const stdout = await startAndStop(home)

  expect(storedCa(home)).not.toBe(before)
  expect(stdout).toContain('"kind":"gateway.ca.replaced"')
}, 5000)

test('a damaged account row under the right vault.key stops the host, names the row, and the printed command removes it', async () => {
  const home = mkdtempSync(join(tmpdir(), "kurumi host's "))
  homes.push(home)
  await startAndStop(home)
  const key = readFileSync(join(home, 'vault.key'))
  storeAccount(home, Buffer.of(0))

  const refused = spawnHost(home)

  expect(await refused.exited).toBe(1)
  const stderr = await new Response(refused.stderr).text()
  const db = join(home, 'kurumi.db')
  const quotedDb = `'${db.replaceAll("'", `'\\''`)}'`
  expect(stderr).toContain(
    `${join(home, 'vault.key')} opens the gateway CA but cannot open 1 account in ${db}: acc-a. If this row came from a backup made with another vault.key, put that key back and start the host again. Otherwise the row is damaged: with the host stopped, run sqlite3 ${quotedDb} 'PRAGMA foreign_keys = ON; DELETE FROM account WHERE id IN ('\\''acc-a'\\'');' and start the host. The command also removes the grants and defaults of this row: add the key again, then set those again with kurumi account grant and kurumi account set-default.`,
  )
  expect(stderr).not.toContain('does not match')
  const printed = / run (sqlite3 .+;') and start/.exec(stderr)?.[1]
  if (!printed) throw new Error('the refusal prints no sqlite3 command')
  expect(Bun.spawnSync(['sh', '-c', printed]).exitCode).toBe(0)
  await startAndStop(home)
  expect(readFileSync(join(home, 'vault.key')).equals(key)).toBe(true)
}, 5000)

test('with accounts stored, a wrong vault.key stops the host, names the backup, and keeps the gateway CA', async () => {
  const home = homeForTest()
  await startAndStop(home)
  const before = storedCa(home)
  storeAccount(home, Buffer.of(0))
  writeFileSync(join(home, 'vault.key'), randomBytes(32), { mode: 0o600 })

  const second = spawnHost(home)

  expect(await second.exited).toBe(1)
  const stderr = await new Response(second.stderr).text()
  expect(stderr).toContain(join(home, 'vault.key'))
  expect(stderr).toContain('from your backup')
  expect(storedCa(home)).toBe(before)
}, 5000)

test('with accounts stored, a gateway CA the vault.key cannot open stops the host, and the printed command replaces it', async () => {
  const home = mkdtempSync(join(tmpdir(), "kurumi host's "))
  homes.push(home)
  await startAndStop(home)
  const key = readFileSync(join(home, 'vault.key'))
  storeAccount(home, seal(key, 'acc-a', 'sk-ant-test'))
  const sqlite = new Database(join(home, 'kurumi.db'))
  sqlite
    .query('UPDATE gateway_ca SET sealed_key = ?')
    .run(seal(randomBytes(32), 'gateway_ca', 'not the CA key'))
  sqlite.close()
  const before = storedCa(home)

  const refused = spawnHost(home)

  expect(await refused.exited).toBe(1)
  const stderr = await new Response(refused.stderr).text()
  const db = join(home, 'kurumi.db')
  expect(stderr).toContain(
    `${join(home, 'vault.key')} cannot open the gateway CA in ${db}: sealed material for gateway_ca failed authentication, and accounts are stored, so the CA is not replaced under this key. If this vault.key did not seal the accounts, put back the one that did from your backup and start the host again. If it did, only the CA is unreadable: with the host stopped, run sqlite3 '${db.replaceAll("'", `'\\''`)}' 'DELETE FROM gateway_ca;' and start the host, and kurumi creates a new CA.`,
  )
  expect(storedCa(home)).toBe(before)
  const printed = / run (sqlite3 .+;') and start/.exec(stderr)?.[1]
  if (!printed) throw new Error('the refusal prints no sqlite3 command')
  expect(Bun.spawnSync(['sh', '-c', printed]).exitCode).toBe(0)
  await startAndStop(home)
  expect(storedCa(home)).not.toBe(before)
  expect(readFileSync(join(home, 'vault.key')).equals(key)).toBe(true)
}, 5000)

test('a stored gateway CA certificate that cannot be parsed stops the host, and the printed command replaces it', async () => {
  const home = mkdtempSync(join(tmpdir(), "kurumi host's "))
  homes.push(home)
  await startAndStop(home)
  const key = readFileSync(join(home, 'vault.key'))
  storeAccount(home, seal(key, 'acc-a', 'sk-ant-test'))
  const sqlite = new Database(join(home, 'kurumi.db'))
  sqlite.query('UPDATE gateway_ca SET cert_pem = ?').run('not a certificate')
  sqlite.close()

  const refused = spawnHost(home)

  expect(await refused.exited).toBe(1)
  const stderr = await new Response(refused.stderr).text()
  const db = join(home, 'kurumi.db')
  expect(stderr).toContain(
    `The gateway CA certificate in ${db} cannot be parsed. With the host stopped, run sqlite3 '${db.replaceAll("'", `'\\''`)}' 'DELETE FROM gateway_ca;' and start the host, and kurumi creates a new CA.`,
  )
  const printed = / run (sqlite3 .+;') and start/.exec(stderr)?.[1]
  if (!printed) throw new Error('the refusal prints no sqlite3 command')
  expect(Bun.spawnSync(['sh', '-c', printed]).exitCode).toBe(0)
  await startAndStop(home)
  expect(storedCa(home)).toStartWith('-----BEGIN CERTIFICATE-----')
  expect(readFileSync(join(home, 'vault.key')).equals(key)).toBe(true)
}, 5000)

const inventoryDocker = `#!/bin/sh
containers="$KURUMI_HOME/containers"
case "$1" in
create)
  for arg; do
    case "$arg" in
    kurumi.session=*) session=\${arg#kurumi.session=} ;;
    kurumi.container=*) container=\${arg#kurumi.container=} ;;
    kurumi.revision=*) revision=\${arg#kurumi.revision=} ;;
    esac
    if [ "$previous" = --name ]; then name=$arg; fi
    previous=$arg
  done
  case "$name" in
  kurumi-probe-*) printf %s "$arg" > "$KURUMI_HOME/probe-url" ;;
  *)
    id=\${name#kurumi-agent-}
    printf '["%s%s","%s","running","agent","%s","%s","%s"]\\n' "$id" "$id" "$name" "$session" "$container" "$revision" >> "$containers" ;;
  esac ;;
ps)
  case "$*" in *kurumi.revision*)
    container=$(printf '%s\\n' "$@" | sed -n 's/^label=kurumi.container=//p')
    if [ -f "$containers" ]; then grep -F '"'"$container" "$containers"; fi ;;
  esac ;;
rm)
  if [ -f "$containers" ]; then
    grep -vF '"'"$3"'"' "$containers" > "$containers.next"
    mv "$containers.next" "$containers"
  fi
  echo "$3" ;;
start)
  if [ "$2" = --attach ]; then
    exec curl -fsS "$(sed s/host.docker.internal/127.0.0.1/ "$KURUMI_HOME/probe-url")"
  fi ;;
wait) while kill -0 "$PPID" 2>/dev/null; do sleep 0.05; done ;;
esac
exit 0
`

test('after a second agent group is created, a restarted host adopts the first group container', async () => {
  const home = homeForTest()
  writeFileSync(join(home, 'docker'), inventoryDocker, { mode: 0o755 })
  mkdirSync(join(home, 'runner'))
  writeFileSync(join(home, 'runner/runner.js'), '')
  const unused = Bun.serve({ port: 0, fetch: () => new Response() })
  const env = { PATH: `${home}:${process.env.PATH}`, KURUMI_AGENT_PORT: String(unused.port) }
  await unused.stop(true)
  const listed = () => {
    const path = join(home, 'containers')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [, name = '', , , , id = '', revision = ''] = z
          .array(z.string())
          .parse(JSON.parse(line))
        return { id, name, revision }
      })
  }
  const containers = () => listed().map(({ name, revision }) => ({ name, revision }))
  const survivesShutdown = async (id: string) => {
    const rows = await cli(home, ['db', 'query', `SELECT status FROM container WHERE id = '${id}'`])
    const [row] = z.array(z.object({ status: z.string() })).parse(JSON.parse(rows))
    return row?.status === 'running'
  }
  const spawnByChat = async (agent: string) => {
    const count = listed().length
    await cli(home, ['chat', agent], 'hello\n')
    for (let attempt = 0; attempt < 250; attempt++) {
      const [created] = listed().slice(count)
      if (created && (await survivesShutdown(created.id)))
        return { name: created.name, revision: created.revision }
      await Bun.sleep(20)
    }
    throw new Error(`no container started running for ${agent}`)
  }

  const first = spawnHost(home, undefined, env)
  await waitForHost(home, first)
  await cli(home, ['agent', 'create', '--name', 'work'])
  const work = await spawnByChat('work')
  await cli(home, ['agent', 'create', '--name', 'play'])
  first.kill('SIGTERM')
  expect(await first.exited).toBe(0)
  const second = spawnHost(home, undefined, env)
  await waitForHost(home, second)
  const play = await spawnByChat('play')
  second.kill('SIGTERM')
  expect(await second.exited).toBe(0)
  const adopted = (await new Response(second.stdout).text())
    .split('\n')
    .filter((line) => line.includes('"kind":"session.container.adopted"'))
    .map((line) => z.object({ name: z.string() }).parse(JSON.parse(line)).name)

  expect(adopted).toEqual([work.name])
  expect(containers()).toEqual([work, { name: play.name, revision: work.revision }])
}, 20000)

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

const outcome = (call: Promise<unknown>) =>
  call.then(
    () => 'answered',
    (error: unknown) => error,
  )

test('the host router answers gateway status and log for the host and refuses them to an agent', async () => {
  const db = openKurumiDb(join(homeForTest(), 'kurumi.db'))
  migrateAll(db, migrations)
  const accessLedger = createAccessLedger({ db })
  const approvalLedger = createApprovalLedger({
    db,
    accessLedger,
    handlers: () => ({ procedure: async () => {}, 'gateway.request': async () => {} }),
    decidePath: ['approval', 'decide'],
    log: () => {},
  })
  const status = {
    admission: 'open',
    detail: null,
    agentPort: { host: '127.0.0.1', port: 4000 },
    caFingerprint: 'AB:CD',
  } as const
  const unused = {} as never
  const contextFor = (caller: HostContext['caller']): HostContext => ({
    db,
    caller,
    guard: approvalLedger.guard,
    grant: null,
    agentLedger: unused,
    accessLedger,
    approvalLedger,
    chatLedger: unused,
    sessionLedger: unused,
    accountLedger: unused,
    gateway: { status: () => status, egressLog: { rows: () => [] }, rules: unused },
    agentPrincipal: null,
  })
  try {
    const host = createRouterClient(hostRouter, { context: contextFor({ kind: 'host' }) })
    expect(await host.gateway.status()).toEqual(status)
    expect(await host.gateway.log({})).toEqual([])

    const agent = createRouterClient(hostRouter, {
      context: contextFor({ kind: 'agent', agentGroupId: 'ag-test', sessionId: 's' }),
    })
    expect(await outcome(agent.gateway.status())).toMatchObject({ code: 'FORBIDDEN' })
    expect(await outcome(agent.gateway.log({}))).toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    db.$client.close()
  }
})

async function cli(home: string, args: string[], stdin = ''): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../cli/src/main.ts'), ...args],
    {
      env: { ...process.env, KURUMI_HOME: home },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect({
    args,
    exit: await child.exited,
    stderr: await new Response(child.stderr).text(),
  }).toEqual({ args, exit: 0, stderr: '' })
  return new Response(child.stdout).text()
}

async function homeWithGrantedAccount(prefix?: string): Promise<{ home: string; key: Buffer }> {
  const home = homeForTest(prefix)
  const first = spawnHost(home)
  await waitForHost(home, first)
  await cli(home, ['agent', 'create', '--name', 'work'])
  await cli(
    home,
    ['account', 'add-key', 'anthropic', '--label', 'main', '--auto-grant'],
    'sk-ant-one\n',
  )
  first.kill('SIGTERM')
  expect(await first.exited).toBe(0)
  const key = readFileSync(join(home, 'vault.key'))
  return { home, key }
}

test('a host whose kurumi.db holds accounts refuses to start without vault.key and writes no new key', async () => {
  const { home } = await homeWithGrantedAccount()
  rmSync(join(home, 'vault.key'))

  const second = spawnHost(home)

  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(
    `${join(home, 'vault.key')} is missing, but ${join(home, 'kurumi.db')} holds 1 account sealed with it`,
  )
  expect(existsSync(join(home, 'vault.key'))).toBe(false)
}, 5000)

test('a host refuses to start with a vault.key that did not seal its accounts', async () => {
  const { home } = await homeWithGrantedAccount()
  writeFileSync(join(home, 'vault.key'), randomBytes(32))

  const second = spawnHost(home)

  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(
    `${join(home, 'vault.key')} does not match the key that sealed the 1 account in ${join(home, 'kurumi.db')}`,
  )
}, 5000)

test('the start-over command a missing vault.key prints, run as printed, lets the host start with a new key', async () => {
  const { home, key } = await homeWithGrantedAccount("kurumi host's ")
  rmSync(join(home, 'vault.key'))
  const refused = spawnHost(home)
  expect(await refused.exited).toBe(1)
  const printed = / run (sqlite3 .+;') \(or delete /.exec(
    await new Response(refused.stderr).text(),
  )?.[1]
  if (!printed) throw new Error('the refusal prints no sqlite3 command')

  expect(Bun.spawnSync(['sh', '-c', printed]).exitCode).toBe(0)
  const host = spawnHost(home)
  await waitForHost(home, host)
  host.kill('SIGTERM')
  expect(await host.exited).toBe(0)

  expect(readFileSync(join(home, 'vault.key')).equals(key)).toBe(false)
  const after = new Database(join(home, 'kurumi.db'), { readonly: true })
  expect(after.query('SELECT count(*) AS n FROM account').get()).toEqual({ n: 0 })
  expect(after.query('SELECT count(*) AS n FROM account_grant').get()).toEqual({ n: 0 })
  after.close()
}, 10000)

test('a FIFO at vault.key is refused as not a regular file instead of blocking start', async () => {
  const home = homeForTest()
  expect(Bun.spawnSync(['mkfifo', '-m', '600', join(home, 'vault.key')]).exitCode).toBe(0)

  const host = spawnHost(home)

  expect(await host.exited).toBe(1)
  expect(await new Response(host.stderr).text()).toContain(
    `${join(home, 'vault.key')} is not a regular file`,
  )
}, 5000)

test('a gateway approval decided before a restart grants its allowance and notifies its session at the next start', async () => {
  const home = homeForTest()
  await startAndStop(home)
  const sqlite = new Database(join(home, 'kurumi.db'))
  sqlite.run(
    `INSERT INTO agent_group (id, name, folder, created_at) VALUES ('ag-1', 'work', 'work', 0)`,
  )
  sqlite.run(
    `INSERT INTO session (id, agent_group_id, mode, status, last_active_at, created_at)
     VALUES ('ses-1', 'ag-1', 'shared', 'active', 0, 0)`,
  )
  sqlite.run(
    `INSERT INTO egress_allowance (approval_id, agent_group_id, session_id, rule_id, account_handle, method, host, path, fingerprint, state, created_at)
     VALUES ('apr-1', 'ag-1', 'ses-1', 'rul-1', 'anthropic/main', 'POST', 'api.anthropic.com', '/v1/messages', x'00', 'pending', 0)`,
  )
  sqlite.run(
    `INSERT INTO pending_approval (id, kind, agent_group_id, session_id, title, body, payload, approvers, status, decided_by, created_at, decided_at)
     VALUES ('apr-1', 'gateway.request', 'ag-1', 'ses-1', 'POST', '[]', '{}', '[]', 'approved', '{"kind":"host"}', 0, 0)`,
  )
  sqlite.close()

  await startAndStop(home)

  const after = new Database(join(home, 'kurumi.db'), { readonly: true })
  try {
    expect(after.query(`SELECT state FROM egress_allowance`).all()).toEqual([{ state: 'granted' }])
    expect(after.query(`SELECT id, kind, status, content FROM inbound_message`).all()).toEqual([
      {
        id: 'ntf-apr-1',
        kind: 'system',
        status: 'pending',
        content: expect.stringMatching(
          /^kurumi: approval apr-1 was approved: POST https:\/\/api\.anthropic\.com\/v1\/messages as anthropic\/main\. /,
        ),
      },
    ])
    expect(
      after
        .query(`SELECT handled_at IS NOT NULL AS handled, handler_error FROM pending_approval`)
        .all(),
    ).toEqual([{ handled: 1, handler_error: null }])
  } finally {
    after.close()
  }
}, 10000)

test('kurumi gateway rules adds, lists, and removes a rule through the host, and names the fix for a bad one', async () => {
  const home = homeForTest()
  const host = spawnHost(home)
  await waitForHost(home, host)
  const view = z.object({ id: z.string() }).passthrough()

  const added = view.parse(
    JSON.parse(
      await cli(home, [
        'gateway',
        'rules',
        'add',
        '--service',
        'anthropic-api',
        '--method',
        'post',
        '--path',
        '/v1/messages/count_tokens',
        '--priority',
        '5',
        '--effect',
        'allow',
      ]),
    ),
  )
  const listed = z.array(view).parse(JSON.parse(await cli(home, ['gateway', 'rules', 'list'])))
  const refused = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../../cli/src/main.ts'),
      'gateway',
      'rules',
      'add',
      '--service',
      'gmail',
      '--host',
      '*.googleapis.com',
    ],
    { env: { ...process.env, KURUMI_HOME: home }, stdout: 'pipe', stderr: 'pipe' },
  )
  const refusal = { exit: await refused.exited, stderr: await new Response(refused.stderr).text() }
  const removed = JSON.parse(await cli(home, ['gateway', 'rules', 'remove', added.id]))
  host.kill('SIGTERM')
  expect(await host.exited).toBe(0)

  expect(added).toMatchObject({
    service: 'anthropic-api',
    method: 'POST',
    path: '/v1/messages/count_tokens',
    priority: 5,
    effect: 'allow',
  })
  expect(listed).toEqual([added])
  expect(refusal.exit).not.toBe(0)
  expect(refusal.stderr).toContain(
    'kurumi matches exact hosts only; add one rule per host, such as www.googleapis.com',
  )
  expect(removed).toEqual({ removed: true })
}, 10000)
