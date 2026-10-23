import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLedger, migrations as agentMigrations } from '@kurumi/agent/server'
import {
  createChatLedger,
  migrations as chatMigrations,
  type InboundEvent,
} from '@kurumi/chat/server'
import { type Db } from '@kurumi/rpc/server'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { container, inboundMessage, outboundMessage } from '../schema.ts'
import {
  createSessionLedger,
  migrations,
  type SessionLedger,
  type SessionRuntime,
  type RuntimeLog,
} from '../server.ts'
import { createFakeDriver } from '../testing.ts'
import {
  createDockerDriver,
  type Cli,
  type CliResult,
  type ContainerSpec,
  type InventoryChange,
} from './docker.ts'
import { FakeCli, type FakeProcess } from './fake-cli.ts'

let sqlite: Database
let db: Db
let home: string
let agents: ReturnType<typeof createAgentLedger>
let chat: ReturnType<typeof createChatLedger>
let ledger: SessionLedger
let driver: ReturnType<typeof createFakeDriver>
let configured: SessionRuntime
let agentId: string
let logs: RuntimeLog[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kurumi-channel-'))
  sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  db = drizzle(sqlite)
  for (const entry of [agentMigrations, chatMigrations, migrations]) {
    migrate(db, { migrationsFolder: entry.folder, migrationsTable: entry.table })
  }
  agents = createAgentLedger({ db, home })
  agentId = agents.create({ name: 'work' }).id
  chat = createChatLedger({
    db,
    agentLedger: agents,
    sink: () => ({ onInbound: (input) => ledger.routeInbound(input) }),
  })
  driver = createFakeDriver()
  configured = {
    driver,
    image: 'test',
    egress: {
      admission: () => ({ open: true }),
      contribution: () => ({ env: {}, mounts: [], network: { kind: 'default' } }),
    },
  }
  logs = []
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: configured,
    runtimeLog: (entry) => logs.push(entry),
  })
})

afterEach(async () => {
  await ledger.stop()
  chat.stop()
  sqlite.close()
  rmSync(home, { recursive: true, force: true })
})

test('Docker realizes labels, declared env and mount modes once for a session', async () => {
  const cli = new FakeCli()
  cli.responses.push({ match: /^(create|start|rm) /, result: {} })
  const docker = createDockerDriver({ install: 'conformance', image: 'agent-test', cli })
  const spec = {
    sessionId: 'ses-conformance',
    containerId: 'ctr-conformance',
    image: 'agent-test',
    env: { KURUMI_TOKEN: 'session-only', KURUMI_URL: 'http://host.docker.internal:4000' },
    mounts: [{ hostPath: import.meta.path, containerPath: '/app/runner.js', readonly: true }],
    network: { kind: 'default' } as const,
    limits: { cpus: 1, memoryMb: 1024, pids: 256 },
  }
  try {
    expect(await docker.run(spec)).toEqual({ ok: true })
    expect(await docker.run(spec)).toEqual({ ok: true })
    const creates = cli.started.filter(({ args }) => args[0] === 'create')
    expect(creates).toHaveLength(1)
    const args = creates[0]?.args ?? []
    const values = (flag: string) =>
      args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
    expect(values('--label')).toEqual([
      'kurumi.install=conformance',
      'kurumi.session=ses-conformance',
      'kurumi.role=agent',
      'kurumi.container=ctr-conformance',
    ])
    expect(values('--env')).toEqual([
      'KURUMI_TOKEN=session-only',
      'KURUMI_URL=http://host.docker.internal:4000',
    ])
    expect(values('--volume')).toEqual([`${import.meta.path}:/app/runner.js:ro`])
    expect(args).toContain('--init')
    expect(args).toContain('--cap-drop=ALL')
    expect(values('--security-opt')).toEqual(['no-new-privileges'])
  } finally {
    const stopping = docker.stop()
    for (const entry of cli.started)
      if (entry.args[0] === 'wait') entry.proc.complete({ code: null })
    await stopping
  }
})

function event(text: string, platformId = agentId): InboundEvent {
  return {
    channel: 'terminal',
    instance: null,
    platformId,
    threadId: null,
    messageId: `in-${crypto.randomUUID()}`,
    receivedAt: performance.now(),
    text,
    sender: { handle: 'terminal:owner', displayName: 'Owner', isBot: false },
    isMention: true,
    isGroup: false,
    attachments: [],
  }
}
function principal(index = 0) {
  const token = driver.runs[index]?.env.KURUMI_TOKEN
  if (!token) throw new Error('missing token')
  const value = ledger.authenticate(token)
  if (!value) throw new Error('missing principal')
  return value
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('condition timed out')
    await Bun.sleep(10)
  }
}

test('channel claims one FIFO item, retries its claim, and completes idempotently', async () => {
  const first = await ledger.routeInbound(event('first'))
  const second = await ledger.routeInbound(event('second'))
  const who = principal()
  const [a, b] = await Promise.all([
    ledger.channel.pull(who, { waitMs: 0 }),
    ledger.channel.pull(who, { waitMs: 0 }),
  ])
  expect(a.messages.map((message) => message.id)).toEqual([first.inboundId])
  expect(b).toEqual(a)
  await ledger.channel.complete(who, { ids: [first.inboundId] })
  await ledger.channel.complete(who, { ids: [first.inboundId] })
  expect(
    (await ledger.channel.pull(who, { waitMs: 0 })).messages.map((message) => message.id),
  ).toEqual([second.inboundId])
})

test('channel refuses cross-session claims, forged principal scope, and unknown input fields', async () => {
  const first = await ledger.routeInbound(event('first'))
  const who = principal()
  const other = agents.create({ name: 'other' }).id
  const second = await ledger.routeInbound(event('second', other))
  await ledger.channel.pull(who, { waitMs: 0 })
  await rejects(ledger.channel.complete(who, { ids: [second.inboundId] }), { code: 'FORBIDDEN' })
  await rejects(ledger.channel.pull({ ...who, agentGroupId: other }, { waitMs: 0 }), {
    code: 'UNAUTHORIZED',
  })
  await rejects(
    ledger.channel.pull(who, Object.assign({ waitMs: 0 }, { sessionId: second.sessionId })),
    { code: 'BAD_REQUEST' },
  )
  expect(
    db.select().from(inboundMessage).where(eq(inboundMessage.id, first.inboundId)).get()?.status,
  ).toBe('processing')
})

test('parked pull wakes on commit and refuses a revoked incarnation before claiming', async () => {
  const first = await ledger.routeInbound(event('first'))
  const who = principal()
  await ledger.channel.pull(who, { waitMs: 0 })
  await ledger.channel.complete(who, { ids: [first.inboundId] })
  const parked = ledger.channel.pull(who, { waitMs: 25000 })
  const next = await ledger.routeInbound(event('next'))
  expect((await parked).messages.map((message) => message.id)).toEqual([next.inboundId])
  await ledger.channel.complete(who, { ids: [next.inboundId] })
  const stale = ledger.channel.pull(who, { waitMs: 25000 })
  const rejected = rejects(stale, { code: 'UNAUTHORIZED' })
  await driver.kill(who.containerId, 0)
  await rejected
  expect(ledger.authenticate(driver.runs[0]?.env.KURUMI_TOKEN ?? '')).toBeNull()
})

test('failed post retries delivery and concurrent duplicate posts publish once', async () => {
  const accepted = await ledger.routeInbound(event('hello'))
  const who = principal()
  await ledger.channel.pull(who, { waitMs: 0 })
  const post = {
    id: 'out-retry',
    inReplyTo: accepted.inboundId,
    body: { kind: 'text' as const, text: 'echo: hello' },
  }
  await rejects(ledger.channel.post(who, post), { code: 'SERVICE_UNAVAILABLE' })
  expect(db.select().from(outboundMessage).get()?.status).toBe('failed')
  const stream = chat.terminal({ agentGroupId: agentId, text: 'next', follow: true })
  await stream.next()
  await Promise.all([ledger.channel.post(who, post), ledger.channel.post(who, post)])
  expect((await stream.next()).value).toEqual({
    kind: 'reply',
    outboundId: post.id,
    text: post.body.text,
  })
  expect(db.select().from(outboundMessage).get()).toMatchObject({
    status: 'delivered',
    attempts: 2,
  })
  expect(logs.filter((entry) => entry.kind === 'session.outbound.delivered')).toHaveLength(1)
  await stream.return()
})

test('admission reopening autonomously starts already committed work', async () => {
  let open = false
  configured.egress.admission = () =>
    open ? { open: true } : { open: false, reason: 'probing', detail: 'waiting', since: new Date() }
  await ledger.start()
  await ledger.routeInbound(event('queued'))
  expect(driver.runs).toHaveLength(0)
  open = true
  await until(() => driver.runs.length === 1)
  expect((await ledger.channel.pull(principal(), { waitMs: 0 })).messages[0]?.content).toBe(
    'queued',
  )
})

test('cleanup uncertainty revokes authority and blocks replacement until removal succeeds', async () => {
  await ledger.start()
  await ledger.routeInbound(event('queued'))
  const who = principal()
  await ledger.channel.pull(who, { waitMs: 0 })
  const kill = driver.kill.bind(driver)
  let cleanupAllowed = false
  driver.kill = async (id, grace) => {
    if (!cleanupAllowed) throw new Error('removal uncertain')
    await kill(id, grace)
  }
  await kill(who.containerId, 0)
  await until(() => db.select().from(container).get()?.status === 'stopping')
  expect(ledger.authenticate(driver.runs[0]?.env.KURUMI_TOKEN ?? '')).toBeNull()
  await Bun.sleep(350)
  expect(driver.runs).toHaveLength(1)
  cleanupAllowed = true
  await until(() => driver.runs.length === 2)
  expect((await ledger.channel.pull(principal(1), { waitMs: 0 })).messages[0]?.content).toBe(
    'queued',
  )
})

test('repeated early exits increase backoff and completed work resets it', async () => {
  await ledger.start()
  await ledger.routeInbound(event('work'))
  await driver.kill(principal().containerId, 0)
  await until(() => driver.runs.length === 2)
  await driver.kill(principal(1).containerId, 0)
  await until(() => driver.runs.length === 3)
  const who = principal(2)
  const claimed = await ledger.channel.pull(who, { waitMs: 0 })
  const id = claimed.messages[0]?.id
  if (!id) throw new Error('work was lost')
  await ledger.channel.complete(who, { ids: [id] })
  await driver.kill(who.containerId, 0)
  expect(
    logs
      .filter((entry) => entry.kind === 'session.restart.scheduled')
      .map((entry) => entry.delayMs),
  ).toEqual([250, 500, 250])
})

test('state and heartbeat remain session scoped and reject revoked incarnations', async () => {
  await ledger.routeInbound(event('work'))
  const who = principal()
  ledger.channel.state.put(who, { key: 'cursor', value: 'one' })
  expect(ledger.channel.state.get(who, { key: 'cursor' })).toEqual({ value: 'one' })
  const before = Date.now()
  ledger.channel.heartbeat(who, { currentTool: 'echo', toolTimeoutMs: 1000 })
  const row = db.select().from(container).where(eq(container.id, who.containerId)).get()
  expect(row?.currentTool).toBe('echo')
  expect(row?.toolDeadlineAt?.getTime()).toBeGreaterThanOrEqual(before + 1000)
  const other = agents.create({ name: 'other' }).id
  await ledger.routeInbound(event('other', other))
  expect(ledger.channel.state.get(principal(1), { key: 'cursor' })).toEqual({ value: null })
  await driver.kill(who.containerId, 0)
  expect(() => ledger.channel.state.put(who, { key: 'cursor', value: 'stale' })).toThrow()
  expect(() => ledger.channel.state.get(who, { key: 'cursor' })).toThrow()
  expect(() => ledger.channel.heartbeat(who, { currentTool: null, toolTimeoutMs: null })).toThrow()
})

test('cancelled pulls release promptly and stop drains parked requests before database closure', async () => {
  const first = await ledger.routeInbound(event('work'))
  const who = principal()
  await ledger.channel.pull(who, { waitMs: 0 })
  await ledger.channel.complete(who, { ids: [first.inboundId] })
  const controller = new AbortController()
  const cancelled = ledger.channel.pull(who, { waitMs: 25000 }, controller.signal)
  const cancelledCheck = rejects(cancelled, { name: 'AbortError' })
  controller.abort()
  await cancelledCheck
  const parked = ledger.channel.pull(who, { waitMs: 25000 })
  const parkedCheck = rejects(parked, { code: 'UNAUTHORIZED' })
  await ledger.stop()
  await parkedCheck
  expect(db.select().from(container).all()).toEqual([])
  expect(ledger.authenticate(driver.runs[0]?.env.KURUMI_TOKEN ?? '')).toBeNull()
  await ledger.stop()
})

test('a replacement retries a delivered reply without publishing it again', async () => {
  await ledger.start()
  const stream = chat.terminal({ agentGroupId: agentId, text: 'work', follow: true })
  const accepted = (await stream.next()).value
  if (!accepted || accepted.kind !== 'queued') throw new Error('missing receipt')
  const old = principal()
  await ledger.channel.pull(old, { waitMs: 0 })
  const post = {
    id: 'out-stable',
    inReplyTo: accepted.inboundId,
    body: { kind: 'text' as const, text: 'echo: work' },
  }
  await ledger.channel.post(old, post)
  expect((await stream.next()).value?.kind).toBe('reply')
  await driver.kill(old.containerId, 0)
  await until(() => driver.runs.length === 2)
  const replacement = principal(1)
  expect((await ledger.channel.pull(replacement, { waitMs: 0 })).messages[0]?.id).toBe(
    accepted.inboundId,
  )
  await ledger.channel.post(replacement, post)
  await ledger.channel.complete(replacement, { ids: [accepted.inboundId] })
  await rejects(ledger.channel.complete(old, { ids: [accepted.inboundId] }), {
    code: 'UNAUTHORIZED',
  })
  expect(db.select().from(outboundMessage).get()?.attempts).toBe(1)
  expect(logs.filter((entry) => entry.kind === 'session.outbound.delivered')).toHaveLength(1)
  await stream.return()
})

test('Docker exit revokes channel authority before removal completes', async () => {
  await ledger.stop()
  const cli = new FakeCli()
  cli.responses.push({ match: /^(create|start) /, result: {} }, { match: /^ps /, result: {} })
  const docker = createDockerDriver({ install: 'channel-conformance', image: 'probe', cli })
  configured.driver = docker
  ledger = createSessionLedger({ db, agentLedger: agents, chatLedger: chat, runtime: configured })
  await ledger.routeInbound(event('work'))
  const create = cli.started.find((call) => call.args[0] === 'create')
  const token = create?.args
    .find((arg) => arg.startsWith('KURUMI_TOKEN='))
    ?.slice('KURUMI_TOKEN='.length)
  if (!token) throw new Error('driver omitted session credentials')
  const who = ledger.authenticate(token)
  if (!who) throw new Error('driver did not start authenticated incarnation')
  const claimed = await ledger.channel.pull(who, { waitMs: 0 })
  expect(claimed.messages[0]?.content).toBe('work')
  await until(() => cli.started.some((call) => call.args[0] === 'wait'))
  const wait = cli.started.find((call) => call.args[0] === 'wait')
  if (!wait) throw new Error('driver did not observe exit')
  wait.proc.complete({ stdout: '137\n' })
  await until(() => cli.started.some((call) => call.args[0] === 'rm'))
  const remove = cli.started.find((call) => call.args[0] === 'rm')
  if (!remove) throw new Error('driver did not remove exited container')
  try {
    expect(ledger.authenticate(token)).toBeNull()
    expect(db.select().from(container).get()?.status).toBe('stopping')
    expect(db.select().from(inboundMessage).get()?.status).toBe('pending')
    await rejects(ledger.channel.pull(who, { waitMs: 0 }), { code: 'UNAUTHORIZED' })
  } finally {
    remove.proc.complete()
    await ledger.stop()
    await docker.stop()
  }
  expect(db.select().from(container).all()).toEqual([])
})

test('concurrent host shutdown retains the stopping row when Docker cannot confirm removal', async () => {
  await ledger.stop()
  const cli = new FakeCli()
  cli.responses.push(
    { match: /^(create|start) /, result: {} },
    { match: /^(rm|ps) /, result: { code: 1, stderr: 'daemon unavailable' } },
  )
  const docker = createDockerDriver({ install: 'shutdown-conformance', image: 'probe', cli })
  const active = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: { ...configured, driver: docker },
  })
  await active.routeInbound(event('work'))
  const row = db.select().from(container).get()
  expect(row?.status).toBe('running')
  const stopping = Promise.allSettled([active.stop(), docker.stop()])
  for (const entry of cli.started) if (entry.args[0] === 'wait') entry.proc.complete({ code: null })
  const outcomes = await stopping
  expect(
    db
      .select()
      .from(container)
      .all()
      .map((entry) => entry.status),
  ).toEqual(['stopping'])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
})

test('late startup success cannot restore a revoked token and stop joins its completion', async () => {
  const startup = Promise.withResolvers<void>()
  driver.beforeRun = () => startup.promise
  const inbound = ledger.routeInbound(event('queued'))
  const who = principal()
  const kill = driver.kill.bind(driver)
  driver.kill = async (id, grace) => {
    startup.resolve()
    await kill(id, grace)
  }
  const stopping = ledger.stop()
  expect(ledger.authenticate(driver.runs[0]?.env.KURUMI_TOKEN ?? '')).toBeNull()
  await stopping
  expect((await inbound).seq).toBe(1)
  expect(db.select().from(container).all()).toEqual([])
  await rejects(ledger.channel.pull(who, { waitMs: 0 }), { code: 'UNAUTHORIZED' })
})

test('post rejects content conflicts and completion of a batch is atomic', async () => {
  const first = await ledger.routeInbound(event('first'))
  const second = await ledger.routeInbound(event('second'))
  const who = principal()
  await ledger.channel.pull(who, { waitMs: 0 })
  await rejects(ledger.channel.complete(who, { ids: [first.inboundId, second.inboundId] }), {
    code: 'FORBIDDEN',
  })
  expect(
    db.select().from(inboundMessage).where(eq(inboundMessage.id, first.inboundId)).get()?.status,
  ).toBe('processing')
  const post = {
    id: 'out-conflict',
    inReplyTo: first.inboundId,
    body: { kind: 'text' as const, text: 'first' },
  }
  await rejects(ledger.channel.post(who, post), { code: 'SERVICE_UNAVAILABLE' })
  await rejects(ledger.channel.post(who, { ...post, body: { kind: 'text', text: 'changed' } }), {
    code: 'CONFLICT',
  })
  expect(db.select().from(outboundMessage).get()).toMatchObject({ content: 'first', attempts: 1 })
})

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : []))
}

type DaemonContainer = { labels: Map<string, string>; state: string; waits: Set<FakeProcess> }

function fakeDaemon() {
  const cli = new FakeCli()
  const containers = new Map<string, DaemonContainer>()
  const streams = new Set<(line: string) => void>()
  const held = new Map<string, (() => void)[]>()
  let late: number | null | undefined
  const emit = (action: string, name: string) => {
    for (const stream of streams) stream(`${action} ${name}`)
  }
  function add(name: string, labels: Record<string, string>, state = 'running') {
    containers.set(name, { labels: new Map(Object.entries(labels)), state, waits: new Set() })
    emit('create', name)
  }
  function exit(name: string, code: number) {
    const entry = containers.get(name)
    if (!entry) return
    entry.state = 'exited'
    for (const wait of entry.waits) wait.complete({ stdout: `${code}\n` })
    entry.waits.clear()
    emit('die', name)
  }
  function remove(name: string): boolean {
    const entry = containers.get(name)
    if (!entry) return false
    if (entry.state === 'running') exit(name, 137)
    containers.delete(name)
    emit('destroy', name)
    return true
  }
  function selected(args: readonly string[]) {
    const filters = flagValues(args, '--filter')
    return [...containers].filter(([name, entry]) =>
      filters.every((filter) => {
        if (filter.startsWith('name=')) return filter === `name=^/${name}$`
        if (!filter.startsWith('label=')) return true
        const [key = '', value = ''] = filter.slice('label='.length).split(/=(.*)/s)
        return entry.labels.get(key) === value
      }),
    )
  }
  function act(args: readonly string[], proc: FakeProcess, onLine?: (line: string) => void) {
    const [command] = args
    const name = args.at(-1) ?? ''
    const answer = (result: Partial<CliResult>) => proc.complete(result)
    const missing = () =>
      answer({ code: 1, stderr: `Error response from daemon: No such entry: ${name}` })
    if (command === 'create') {
      const created = flagValues(args, '--name')[0] ?? ''
      const labels = Object.fromEntries(
        flagValues(args, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2)),
      )
      if (late !== undefined) {
        const code = late
        late = undefined
        answer({ code })
        setTimeout(() => add(created, labels, 'created'), 5)
        return
      }
      add(created, labels, 'created')
      answer({ stdout: `${created}\n` })
    } else if (command === 'start') {
      const entry = containers.get(name)
      if (!entry) return missing()
      entry.state = 'running'
      if (args[1] === '--attach') {
        remove(name)
        return answer({ stdout: 'probe-body' })
      }
      answer({})
    } else if (command === 'wait') {
      const entry = containers.get(name)
      if (!entry) return missing()
      if (entry.state === 'running') entry.waits.add(proc)
      else answer({ stdout: '0\n' })
    } else if (command === 'stop') {
      exit(name, 143)
      answer({})
    } else if (command === 'rm') {
      if (remove(name)) answer({ stdout: `${name}\n` })
      else missing()
    } else if (command === 'ps') {
      const format = flagValues(args, '--format')[0] ?? '{{.Names}}'
      answer({
        stdout: selected(args)
          .map(([listed, entry]) =>
            format
              .replaceAll('{{.Names}}', listed)
              .replaceAll('{{.State}}', entry.state)
              .replace(
                /\{\{\.Label "([^"]+)"\}\}/g,
                (_match, key: string) => entry.labels.get(key) ?? '',
              ),
          )
          .map((line) => `${line}\n`)
          .join(''),
      })
    } else if (command === 'events' && onLine) {
      streams.add(onLine)
      void proc.result.then(
        () => streams.delete(onLine),
        () => streams.delete(onLine),
      )
    }
  }
  const daemon: Cli = {
    start(args, options) {
      const proc = cli.start(args)
      const queue = held.get(args[0] ?? '')
      if (queue) queue.push(() => act(args, proc, options?.onLine))
      else act(args, proc, options?.onLine)
      return {
        result: proc.result,
        kill() {
          proc.kill()
          proc.complete({ code: null })
        },
      }
    },
  }
  return {
    cli,
    daemon,
    containers,
    add,
    exit,
    remove,
    hold(command: string) {
      held.set(command, [])
    },
    release(command: string) {
      const queue = held.get(command) ?? []
      held.delete(command)
      for (const action of queue) action()
    },
    lateCreate(code: number | null) {
      late = code
    },
    commands: (command: string) => cli.started.filter(({ args }) => args[0] === command),
  }
}

function agentSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    sessionId: 'ses-adopt',
    containerId: 'ctr-adopt',
    image: 'agent-test',
    env: { KURUMI_TOKEN: 'secret' },
    mounts: [{ hostPath: import.meta.path, containerPath: '/app/runner.js', readonly: true }],
    network: { kind: 'default' },
    limits: { cpus: 1, memoryMb: 1024, pids: 256 },
    ...overrides,
  }
}

test('a new driver adopts a running agent from its labels alone and a repeated run creates nothing', async () => {
  const docker = fakeDaemon()
  const previous = createDockerDriver({ install: 'adopt', image: 'agent-test', cli: docker.daemon })
  expect(await previous.run(agentSpec())).toEqual({ ok: true })
  await previous.detach()
  const restarted = createDockerDriver({
    install: 'adopt',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const name = restarted.nameOf('ctr-adopt')
  const exits: [string, number][] = []
  restarted.onExit((id, code) => exits.push([id, code]))
  try {
    const listed = await restarted.sweep()
    expect(listed).toEqual([
      { name, role: 'agent', sessionId: 'ses-adopt', containerId: 'ctr-adopt', state: 'running' },
    ])
    const before = docker.cli.started.length
    expect(listed.map((entry) => restarted.adopt(entry))).toEqual([{ ok: true }])
    expect(await restarted.run(agentSpec())).toEqual({ ok: true })
    expect(docker.cli.joined().slice(before)).toEqual([`wait ${name}`])
    docker.exit(name, 7)
    await until(() => exits.length === 1)
    expect(exits).toEqual([['ctr-adopt', 7]])
  } finally {
    await restarted.stop()
  }
  expect(docker.containers.size).toBe(0)
})

test('adoption refuses a entry whose name does not follow from its labels', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'adopt',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const forged = {
    name: 'kurumi-agent-forged',
    role: 'agent',
    sessionId: 'ses-adopt',
    containerId: 'ctr-adopt',
    state: 'running',
  }
  expect(dockerDriver.adopt(forged).ok).toBe(false)
  expect(docker.commands('wait')).toHaveLength(0)
  await dockerDriver.stop()
})

test('detach leaves running agents and removes only an agent that is still starting', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'detach',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const exits: string[] = []
  dockerDriver.onExit((id) => exits.push(id))
  expect(await dockerDriver.run(agentSpec())).toEqual({ ok: true })
  docker.hold('create')
  const starting = dockerDriver.run(agentSpec({ sessionId: 'ses-two', containerId: 'ctr-two' }))
  await until(() => docker.commands('create').length === 2)
  const detaching = dockerDriver.detach()
  docker.release('create')
  expect((await starting).ok).toBe(false)
  await detaching
  const kept = dockerDriver.nameOf('ctr-adopt')
  expect([...docker.containers].map(([name, entry]) => [name, entry.state])).toEqual([
    [kept, 'running'],
  ])
  expect(docker.commands('wait').map(({ proc }) => proc.killed)).toEqual([true])
  expect(docker.commands('rm').map(({ args }) => args.at(-1))).toEqual([
    dockerDriver.nameOf('ctr-two'),
  ])
  expect(exits).toEqual([])
  expect((await dockerDriver.run(agentSpec({ sessionId: 'ses-three' }))).ok).toBe(false)
})

test('a sweep lists and removes only containers that carry this install label', async () => {
  const docker = fakeDaemon()
  docker.add('other-agent', {
    'kurumi.install': 'other',
    'kurumi.role': 'agent',
    'kurumi.session': 'ses-adopt',
    'kurumi.container': 'ctr-adopt',
  })
  docker.add('other-probe', { 'kurumi.install': 'other', 'kurumi.role': 'probe' })
  docker.add('own-probe', { 'kurumi.install': 'mine', 'kurumi.role': 'probe' }, 'exited')
  const dockerDriver = createDockerDriver({
    install: 'mine',
    image: 'agent-test',
    cli: docker.daemon,
  })
  try {
    expect(await dockerDriver.sweep()).toEqual([
      { name: 'own-probe', role: 'probe', sessionId: '', containerId: '', state: 'exited' },
    ])
    await dockerDriver.remove('own-probe')
    await dockerDriver.kill('ctr-adopt', 0)
  } finally {
    await dockerDriver.stop()
  }
  expect([...docker.containers.keys()]).toEqual(['other-agent', 'other-probe'])
  expect(docker.cli.joined().join('\n')).not.toMatch(/other-|kurumi\.install=other/)
})

test.each([143, 2, null])(
  'an agent create CLI that ends with %p stays unconfirmed until a later sweep lets cleanup remove its late entry',
  async (code) => {
    const docker = fakeDaemon()
    const dockerDriver = createDockerDriver({
      install: 'late',
      image: 'agent-test',
      cli: docker.daemon,
    })
    docker.lateCreate(code)
    try {
      expect((await dockerDriver.run(agentSpec())).ok).toBe(false)
      await until(() => docker.containers.size === 1)
      expect(await dockerDriver.kill('ctr-adopt', 0).then(() => 'removed', String)).toContain(
        'unconfirmed',
      )
      expect(docker.containers.size).toBe(1)
      await dockerDriver.sweep()
      await dockerDriver.kill('ctr-adopt', 0)
      expect(docker.containers.size).toBe(0)
    } finally {
      await dockerDriver.stop()
    }
  },
)

test('a probe whose create CLI exits 2 blocks the next probe until a sweep settles its name', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'probe',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const url = 'http://host.docker.internal:1/probe/nonce'
  docker.lateCreate(2)
  try {
    expect(await dockerDriver.probe(url).then(() => 'opened', String)).toContain('unconfirmed')
    await until(() => docker.containers.size === 1)
    expect(await dockerDriver.probe(url).then(() => 'opened', String)).toContain('unconfirmed')
    expect(docker.commands('create')).toHaveLength(1)
    expect(await dockerDriver.sweep()).toEqual([])
    expect(await dockerDriver.probe(url)).toBe('probe-body')
    expect(docker.containers.size).toBe(0)
  } finally {
    await dockerDriver.stop()
  }
})

test('one events subscription per driver follows this install and resubscribes after a loss', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'events',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const changes: InventoryChange[] = []
  const unwatch = [
    dockerDriver.watch((change) => changes.push(change)),
    dockerDriver.watch(() => {}),
  ]
  const [first] = docker.commands('events')
  expect(docker.commands('events')).toHaveLength(1)
  expect(first?.args).toContain('label=kurumi.install=events')
  expect(first?.args).toContain('--until')
  expect(first?.args).not.toContain('--since')
  docker.add('kurumi-agent-new', { 'kurumi.install': 'events' })
  first?.proc.complete({ code: null })
  await until(() => docker.commands('events').length === 2)
  const resumed = docker.commands('events')[1]
  expect(resumed?.args).toContain('--since')
  expect(changes).toEqual([
    { kind: 'subscribed', attempt: 0 },
    { kind: 'event', action: 'create', name: 'kurumi-agent-new' },
    { kind: 'lost', code: null, retryMs: 1000 },
    { kind: 'subscribed', attempt: 1 },
  ])
  for (const stop of unwatch) stop()
  expect(resumed?.proc.killed).toBe(true)
  await Bun.sleep(1100)
  expect(docker.commands('events')).toHaveLength(2)
  await dockerDriver.stop()
})

test('a subscription that reaches the end of its window continues at once from where it ended', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'events',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const changes: InventoryChange[] = []
  const unwatch = dockerDriver.watch((change) => changes.push(change))
  const [first] = docker.commands('events')
  const windowEnd = Number(first?.args[(first?.args.indexOf('--until') ?? 0) + 1])
  try {
    setSystemTime(new Date(windowEnd * 1000))
    first?.proc.complete({ code: 0 })
    await Bun.sleep(0)
    const next = docker.commands('events')[1]
    expect(Number(next?.args[(next?.args.indexOf('--since') ?? 0) + 1])).toBe(windowEnd - 1)
  } finally {
    setSystemTime()
    unwatch()
    await dockerDriver.stop()
  }
  expect(changes).toEqual([{ kind: 'subscribed', attempt: 0 }])
})
