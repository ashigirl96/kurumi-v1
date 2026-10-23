import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  type ListedContainer,
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
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
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

test('cancelled pulls release promptly and stop ends parked pulls with a retryable refusal while the incarnation stays', async () => {
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
  const parkedCheck = rejects(parked, { code: 'SERVICE_UNAVAILABLE' })
  await ledger.stop()
  await parkedCheck
  await rejects(ledger.channel.pull(who, { waitMs: 0 }), { code: 'SERVICE_UNAVAILABLE' })
  expect(db.select().from(container).all()).toMatchObject([
    { id: who.containerId, status: 'running' },
  ])
  expect(driver.runs).toHaveLength(1)
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

test('host shutdown keeps a running container and its row even when Docker cannot answer', async () => {
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
  expect(db.select().from(container).get()?.status).toBe('running')
  const stopping = Promise.allSettled([active.stop(), docker.detach()])
  for (const entry of cli.started) if (entry.args[0] === 'wait') entry.proc.complete({ code: null })
  const outcomes = await stopping
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(cli.joined().filter((call) => /^(rm|stop) /.test(call))).toEqual([])
  expect(db.select().from(container).get()?.status).toBe('running')
})

test('stop waits for a startup in flight and keeps the incarnation it started', async () => {
  const startup = Promise.withResolvers<void>()
  driver.beforeRun = () => startup.promise
  const inbound = ledger.routeInbound(event('queued'))
  const stopping = ledger.stop()
  let stopped = false
  stopping.then(
    () => {
      stopped = true
    },
    () => {},
  )
  await Bun.sleep(20)
  expect(stopped).toBe(false)
  startup.resolve()
  await stopping
  expect((await inbound).seq).toBe(1)
  expect(db.select().from(container).all()).toMatchObject([{ status: 'running' }])
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

type DaemonContainer = {
  id: string
  labels: Map<string, string>
  state: string
  waits: Set<FakeProcess>
  links: string[]
}

function render(format: string, name: string, entry: DaemonContainer, noTrunc: boolean): string {
  const field = (expression: string) => {
    const label = /^\(?\.Label "([^"]+)"\)?$/.exec(expression)?.[1]
    if (label !== undefined) return entry.labels.get(label) ?? ''
    if (expression === '.ID') return noTrunc ? entry.id : entry.id.slice(0, 12)
    if (expression === '.Names') return noTrunc ? [name, ...entry.links].join(',') : name
    if (expression === '.State') return entry.state
    throw new Error(`the fake daemon cannot render ${expression}`)
  }
  return format.replace(
    /\{\{(json )?(.+?)\}\}/g,
    (_match, json: string | undefined, expression: string) =>
      json ? JSON.stringify(field(expression)) : field(expression),
  )
}

function fakeDaemon() {
  const cli = new FakeCli()
  const containers = new Map<string, DaemonContainer>()
  const images = new Map<string, Record<string, string>>()
  const streams = new Set<(line: string) => void>()
  const held = new Map<string, (() => void)[]>()
  const failing = new Set<string>()
  let extraListing: string | undefined
  let late: number | null | undefined
  const emit = (action: string, name: string) => {
    for (const stream of streams) stream(`${action} ${name}`)
  }
  function add(name: string, labels: Record<string, string>, state = 'running') {
    containers.set(name, {
      id: randomBytes(32).toString('hex'),
      labels: new Map(Object.entries(labels)),
      state,
      waits: new Set(),
      links: [],
    })
    emit('create', name)
  }
  function resolve(reference: string): string {
    for (const [name, entry] of containers) if (entry.id === reference) return name
    return reference
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
        if (filter.startsWith('id=')) return entry.id.includes(filter.slice('id='.length))
        if (!filter.startsWith('label=')) return true
        const [key = '', value = ''] = filter.slice('label='.length).split(/=(.*)/s)
        return entry.labels.get(key) === value
      }),
    )
  }
  function act(args: readonly string[], proc: FakeProcess, onLine?: (line: string) => void) {
    const [command] = args
    const reference = args.at(-1) ?? ''
    const name = resolve(reference)
    const answer = (result: Partial<CliResult>) => proc.complete(result)
    const missing = () =>
      answer({ code: 1, stderr: `Error response from daemon: No such entry: ${reference}` })
    if (command === 'create') {
      const created = flagValues(args, '--name')[0] ?? ''
      const labels = {
        ...images.get(args[args.indexOf('bun') - 1] ?? ''),
        ...Object.fromEntries(
          flagValues(args, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2)),
        ),
      }
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
      if (remove(name)) answer({ stdout: `${reference}\n` })
      else missing()
    } else if (command === 'ps') {
      const format = flagValues(args, '--format')[0] ?? '{{.Names}}'
      const noTrunc = args.includes('--no-trunc')
      const lines = selected(args).map(([listed, entry]) => render(format, listed, entry, noTrunc))
      if (noTrunc && extraListing !== undefined) lines.push(extraListing)
      answer({ stdout: lines.map((line) => `${line}\n`).join('') })
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
      const [command = ''] = args
      const queue = held.get(command)
      if (failing.has(command))
        proc.complete({ code: 1, stderr: 'Cannot connect to the Docker daemon' })
      else if (queue) queue.push(() => act(args, proc, options?.onLine))
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
    labelImage(image: string, labels: Record<string, string>) {
      images.set(image, labels)
    },
    appendListing(line: string | undefined) {
      extraListing = line
    },
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
    fail(command: string) {
      failing.add(command)
    },
    recover(command: string) {
      failing.delete(command)
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
      {
        dockerId: docker.containers.get(name)?.id ?? '',
        name,
        role: 'agent',
        sessionId: 'ses-adopt',
        containerId: 'ctr-adopt',
        revision: null,
        state: 'running',
      },
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

test('adoption refuses a container whose name does not follow from its labels', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'adopt',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const forged: ListedContainer = {
    dockerId: 'f'.repeat(64),
    name: 'kurumi-agent-forged',
    role: 'agent',
    sessionId: 'ses-adopt',
    containerId: 'ctr-adopt',
    revision: null,
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

test('a removal that gets no answer is killed after the driver timeout instead of hanging', async () => {
  const docker = fakeDaemon()
  docker.add('kurumi-agent-stuck', {
    'kurumi.install': 'stuck',
    'kurumi.role': 'agent',
    'kurumi.session': 'ses-stuck',
    'kurumi.container': 'ctr-stuck',
  })
  docker.hold('rm')
  const dockerDriver = createDockerDriver({
    install: 'stuck',
    image: 'agent-test',
    cli: docker.daemon,
    timeoutMs: 50,
  })
  const started = performance.now()
  const outcome = await dockerDriver.kill('ctr-stuck', 0).then(() => 'removed', String)
  expect(outcome).toContain('unconfirmed')
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(docker.commands('rm').map(({ proc }) => proc.killed)).toEqual([true])
  const id = docker.containers.get('kurumi-agent-stuck')?.id
  expect(docker.commands('rm').map(({ args }) => args.at(-1))).toEqual([id])
  expect(flagValues(docker.commands('ps').at(-1)?.args ?? [], '--filter')).toEqual([`id=${id}`])
  docker.release('rm')
  await dockerDriver.stop().catch(() => {})
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
    const listed = await dockerDriver.sweep()
    expect(listed).toEqual([
      {
        dockerId: docker.containers.get('own-probe')?.id ?? '',
        name: 'own-probe',
        role: 'probe',
        sessionId: null,
        containerId: null,
        revision: null,
        state: 'exited',
      },
    ])
    for (const entry of listed) await dockerDriver.remove(entry)
    await dockerDriver.kill('ctr-adopt', 0)
    expect(docker.commands('rm').map(({ args }) => args.at(-1))).toEqual(
      listed.map(({ dockerId }) => dockerId),
    )
  } finally {
    await dockerDriver.stop()
  }
  expect([...docker.containers.keys()]).toEqual(['other-agent', 'other-probe'])
  expect(docker.cli.joined().join('\n')).not.toMatch(/other-|kurumi\.install=other/)
})

test.each([143, 2, null])(
  'an agent create CLI that ends with %p stays unconfirmed until a later sweep lets cleanup remove its late container',
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

test('a driver has one events subscription that follows this install, reports it only after a second alive, and replays from the last one that ran', async () => {
  const docker = fakeDaemon()
  const dockerDriver = createDockerDriver({
    install: 'events',
    image: 'agent-test',
    cli: docker.daemon,
  })
  const changes: InventoryChange[] = []
  const unwatch = dockerDriver.watch((change) => changes.push(change))
  expect(() => dockerDriver.watch(() => {})).toThrow('already has a watcher')
  const since = (index: number) => {
    const args = docker.commands('events')[index]?.args ?? []
    return args.includes('--since') ? Number(args[args.indexOf('--since') + 1]) : null
  }
  const [first] = docker.commands('events')
  expect(docker.commands('events')).toHaveLength(1)
  expect(first?.args).toContain('label=kurumi.install=events')
  expect(first?.args).toContain('--until')
  expect(since(0)).toBeNull()
  const firstStart = Number(first?.args[(first?.args.indexOf('--until') ?? 0) + 1]) - 60
  docker.add('kurumi-agent-new', { 'kurumi.install': 'events' })
  await until(() => changes.length === 2)
  first?.proc.complete({ code: null })
  await until(() => docker.commands('events').length === 2)
  expect(since(1)).toBeCloseTo(firstStart - 1, 2)
  docker.commands('events')[1]?.proc.complete({ code: 1 })
  await until(() => docker.commands('events').length === 3, 4_000)
  expect(since(2)).toBeCloseTo(firstStart - 1, 2)
  expect(changes).toEqual([
    { kind: 'event' },
    { kind: 'subscribed', attempt: 0 },
    { kind: 'lost', code: null, retryMs: 1000 },
    { kind: 'lost', code: 1, retryMs: 2000 },
  ])
  unwatch()
  expect(docker.commands('events')[2]?.proc.killed).toBe(true)
  await Bun.sleep(1_100)
  expect(docker.commands('events')).toHaveLength(3)
  await dockerDriver.stop()
}, 10_000)

test('a subscription that reaches the end of its window resubscribes at once and replays the previous window', async () => {
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
    await until(() => changes.length === 1)
    first?.proc.complete({ code: 0 })
    await Bun.sleep(0)
    const next = docker.commands('events')[1]
    expect(Number(next?.args[(next?.args.indexOf('--since') ?? 0) + 1])).toBeCloseTo(
      windowEnd - 61,
      2,
    )
    await Bun.sleep(1_100)
  } finally {
    unwatch()
    await dockerDriver.stop()
  }
  expect(changes).toEqual([{ kind: 'subscribed', attempt: 0 }])
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function supervisedHost(
  docker: ReturnType<typeof fakeDaemon>,
  {
    revision = 'rev-1',
    ...limits
  }: { staleAfterMs?: number; intervalMs?: number; revision?: string } = {},
) {
  const dockerDriver = createDockerDriver({
    install: 'restart',
    revision,
    image: 'agent-test',
    cli: docker.daemon,
  })
  const sessions = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: {
      ...configured,
      driver: dockerDriver,
      supervision: { staleAfterMs: 60_000, intervalMs: 60_000, ...limits },
    },
    runtimeLog: (entry) => logs.push(entry),
  })
  ledger = sessions
  return {
    dockerDriver,
    sessions,
    stop: () => Promise.all([sessions.stop(), dockerDriver.detach()]),
  }
}

function tokens(docker: ReturnType<typeof fakeDaemon>): string[] {
  return docker.commands('create').map(
    ({ args }) =>
      flagValues(args, '--env')
        .find((entry) => entry.startsWith('KURUMI_TOKEN='))
        ?.slice('KURUMI_TOKEN='.length) ?? '',
  )
}

async function servedOnce(host: ReturnType<typeof supervisedHost>, token: string) {
  const who = host.sessions.authenticate(token)
  if (!who) throw new Error('the container token was refused')
  const { messages } = await host.sessions.channel.pull(who, { waitMs: 0 })
  const ids = messages.map((message) => message.id)
  if (ids.length) await host.sessions.channel.complete(who, { ids })
  return { who, messages }
}

const decisionKinds = new Set([
  'session.container.adopted',
  'session.container.reaped',
  'session.container.stopped',
  'session.adoption.done',
])

function decisions(since: number, kinds: ReadonlySet<string> = decisionKinds) {
  return logs.slice(since).filter((entry) => kinds.has(entry.kind))
}

async function restartedHost(
  docker: ReturnType<typeof fakeDaemon>,
  limits: { staleAfterMs?: number; intervalMs?: number } = {},
) {
  const first = supervisedHost(docker)
  await first.sessions.start()
  await first.sessions.routeInbound(event('before restart'))
  const [token = ''] = tokens(docker)
  const { who } = await servedOnce(first, token)
  await first.stop()
  return { token, who, first, limits }
}

test('a restarted host adopts its running container from the labels, keeps the token and creates nothing', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token, who: before } = await restartedHost(docker)
  const restartedAt = logs.length
  const restarted = supervisedHost(docker)
  try {
    await restarted.sessions.start()
    await restarted.sessions.adopted()
    const next = await restarted.sessions.routeInbound(event('after restart'))
    const { who: after, messages } = await servedOnce(restarted, token)
    expect(after.containerId).toBe(before.containerId)
    expect(messages.map((message) => message.id)).toEqual([next.inboundId])
    expect(docker.commands('create')).toHaveLength(1)
    const name = restarted.dockerDriver.nameOf(before.containerId)
    expect(docker.commands('wait').map(({ args, proc }) => [args[1], proc.killed])).toEqual([
      [name, true],
      [name, false],
    ])
    expect(decisions(restartedAt)).toMatchObject([
      {
        kind: 'session.container.adopted',
        sessionId: before.sessionId,
        containerId: before.containerId,
        name,
        reason: 'running container matches its row',
      },
      { kind: 'session.adoption.done', adopted: 1, reaped: 0, stopped: 0 },
    ])
  } finally {
    await restarted.stop()
  }
})

test('a restarted host reaps the row of a container removed while it was down and answers from a new one', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token, who, first } = await restartedHost(docker)
  docker.remove(first.dockerDriver.nameOf(who.containerId))
  const restartedAt = logs.length
  const restarted = supervisedHost(docker)
  try {
    await restarted.sessions.start()
    expect(restarted.sessions.authenticate(token)).toBeNull()
    expect(decisions(restartedAt)).toMatchObject([
      {
        kind: 'session.container.reaped',
        containerId: who.containerId,
        reason: 'container missing',
      },
      { kind: 'session.adoption.done', adopted: 0, reaped: 1, stopped: 0 },
    ])
    const next = await restarted.sessions.routeInbound(event('after restart'))
    await until(() => docker.commands('create').length === 2)
    const fresh = tokens(docker)[1] ?? ''
    await until(() => restarted.sessions.authenticate(fresh) !== null)
    expect((await servedOnce(restarted, fresh)).messages.map((message) => message.id)).toEqual([
      next.inboundId,
    ])
  } finally {
    await restarted.stop()
  }
})

test('a restarted host stops containers without a live row and never touches another install', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  docker.add('kurumi-agent-ghost', {
    'kurumi.install': 'restart',
    'kurumi.role': 'agent',
    'kurumi.session': 'ses-ghost',
    'kurumi.container': 'ctr-ghost',
  })
  docker.add(
    'kurumi-probe-left',
    { 'kurumi.install': 'restart', 'kurumi.role': 'probe' },
    'created',
  )
  docker.add('hand-made', { 'kurumi.install': 'restart' })
  docker.add('kurumi-agent-other', {
    'kurumi.install': 'other',
    'kurumi.role': 'agent',
    'kurumi.session': 'ses-ghost',
    'kurumi.container': 'ctr-ghost',
  })
  const host = supervisedHost(docker)
  try {
    await host.sessions.start()
    await until(() => decisions(0).length === 4)
    expect([...docker.containers.keys()]).toEqual(['kurumi-agent-other'])
    expect(decisions(0)).toMatchObject([
      { kind: 'session.adoption.done', adopted: 0, reaped: 0, stopped: 3 },
      { kind: 'session.container.stopped', name: 'kurumi-agent-ghost', reason: 'no live row' },
      { kind: 'session.container.stopped', name: 'kurumi-probe-left', reason: 'leftover probe' },
      { kind: 'session.container.stopped', name: 'hand-made', reason: 'unknown role' },
    ])
    expect(docker.cli.joined().join('\n')).not.toMatch(/kurumi-agent-other|kurumi\.install=other/)
  } finally {
    await host.stop()
  }
})

test('a label value that carries a newline and other names never makes the sweep remove those containers', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  docker.add('kurumi-agent-other', {
    'kurumi.install': 'other',
    'kurumi.role': 'agent',
    'kurumi.session': 'ses-other',
    'kurumi.container': 'ctr-other',
  })
  docker.add('unlabelled', {})
  docker.add('injector', {
    'kurumi.install': 'restart',
    'kurumi.role': 'x\nkurumi-agent-other\nunlabelled',
  })
  const host = supervisedHost(docker)
  try {
    await host.sessions.start()
    await until(() => !docker.containers.has('injector'))
    await Bun.sleep(50)
    expect([...docker.containers.keys()]).toEqual(['kurumi-agent-other', 'unlabelled'])
    expect(docker.cli.joined().join('\n')).not.toMatch(/kurumi-agent-other|unlabelled/)
  } finally {
    await host.stop()
  }
})

test('a probe image label that carries a newline and another name never makes the sweep remove that container', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  docker.add('unlabelled', {})
  docker.labelImage('agent-test', { 'kurumi.session': 'x\nunlabelled' })
  docker.hold('start')
  const host = supervisedHost(docker)
  const probing = host.dockerDriver.probe('http://host.docker.internal:1/probe/nonce').catch(String)
  try {
    await until(() => docker.commands('start').length === 1)
    await host.sessions.start()
    await host.sessions.adopted()
    await Bun.sleep(50)
    docker.release('start')
    expect(await probing).toBe('probe-body')
    expect([...docker.containers.keys()]).toEqual(['unlabelled'])
    expect(docker.cli.joined().join('\n')).not.toMatch(/unlabelled/)
  } finally {
    await host.stop()
  }
})

test('a forged listing line naming a running agent with other labels never makes the restarted host reap it', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token, who, first } = await restartedHost(docker)
  const name = first.dockerDriver.nameOf(who.containerId)
  docker.add('injector', {
    'kurumi.install': 'restart',
    'kurumi.revision': `x\n${name}|agent|ses-forged|${who.containerId}|rev-1`,
  })
  const restartedAt = logs.length
  const restarted = supervisedHost(docker)
  try {
    await restarted.sessions.start()
    await restarted.sessions.adopted()
    await until(() => !docker.containers.has('injector'))
    await Bun.sleep(50)
    expect(restarted.sessions.authenticate(token)).not.toBeNull()
    expect(docker.containers.get(name)?.state).toBe('running')
    expect(docker.commands('rm').map(({ args }) => args.at(-1))).not.toContain(name)
    expect(decisions(restartedAt)).toContainEqual(
      expect.objectContaining({ kind: 'session.container.adopted', name }),
    )
  } finally {
    await restarted.stop()
  }
})

test('a forged listing line never makes the restarted host adopt a container outside its listing or end a docker wait for it', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { who, first } = await restartedHost(docker)
  const name = first.dockerDriver.nameOf(who.containerId)
  docker.remove(name)
  docker.add(name, {})
  docker.add('injector', {
    'kurumi.install': 'restart',
    'kurumi.revision': `x\n${name}|agent|${who.sessionId}|${who.containerId}|rev-1`,
  })
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-forged-wait-'))
  writeFileSync(join(dir, 'docker'), '#!/bin/sh\nwhile :; do sleep 0.05; done\n', { mode: 0o755 })
  const spawned = Bun.spawn(
    ['sh', '-c', `"${dir}/docker" wait ${name} >/dev/null 2>&1 & echo $!`],
    { stdout: 'pipe' },
  )
  const foreign = Number((await new Response(spawned.stdout).text()).trim())
  const restartedAt = logs.length
  const before = docker.cli.started.length
  const restarted = supervisedHost(docker)
  try {
    await restarted.sessions.start()
    await restarted.sessions.adopted()
    await until(() => !docker.containers.has('injector'))
    await Bun.sleep(200)
    expect(isAlive(foreign)).toBe(true)
    expect(
      docker.cli
        .joined()
        .slice(before)
        .filter((line) => line.includes(name)),
    ).toEqual([])
    expect(decisions(restartedAt)).toContainEqual(
      expect.objectContaining({
        kind: 'session.container.reaped',
        containerId: who.containerId,
        reason: 'container missing',
      }),
    )
  } finally {
    if (isAlive(foreign)) process.kill(foreign, 'SIGTERM')
    await restarted.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kill() without a record removes the containers its label listing names by ID and nothing a label value names', async () => {
  const docker = fakeDaemon()
  docker.add('unlabelled', {})
  docker.add('injector', {
    'kurumi.install': 'stuck',
    'kurumi.role': 'agent',
    'kurumi.container': 'ctr-stuck',
    'kurumi.session': 'x\nunlabelled',
  })
  const id = docker.containers.get('injector')?.id
  const dockerDriver = createDockerDriver({
    install: 'stuck',
    image: 'agent-test',
    cli: docker.daemon,
  })
  try {
    await dockerDriver.kill('ctr-stuck', 0)
    expect([...docker.containers.keys()]).toEqual(['unlabelled'])
    expect(docker.commands('rm').map(({ args }) => args.at(-1))).toEqual([id])
    expect(docker.cli.joined().join('\n')).not.toMatch(/unlabelled/)
  } finally {
    await dockerDriver.stop()
  }
})

test.each([
  ['a line that is not JSON', 'kurumi-agent-x|agent|ses|ctr||running'],
  ['a line with six fields', `["${'a'.repeat(64)}","x","running","","",""]`],
  ['a truncated ID', '["aaaaaaaaaaaa","x","running","","","",""]'],
  ['two names without a link', `["${'a'.repeat(64)}","x,y","running","","","",""]`],
])(
  'a listing with %s fails the pass, keeps adoption closed and removes nothing until it parses',
  async (_case, line) => {
    await ledger.stop()
    const docker = fakeDaemon()
    const { token } = await restartedHost(docker)
    docker.add('kurumi-agent-ghost', { 'kurumi.install': 'restart', 'kurumi.role': 'agent' })
    docker.appendListing(line)
    const restartedAt = logs.length
    const removals = docker.commands('rm').length
    const restarted = supervisedHost(docker, { intervalMs: 50 })
    let adopted = false
    try {
      await restarted.sessions.start()
      void restarted.sessions.adopted().then(
        () => {
          adopted = true
        },
        () => {},
      )
      await Bun.sleep(150)
      expect(adopted).toBe(false)
      expect(restarted.sessions.authenticate(token)).toBeNull()
      expect(docker.commands('rm')).toHaveLength(removals)
      expect(logs.slice(restartedAt)).toContainEqual(
        expect.objectContaining({
          kind: 'session.reconcile.failed',
          reason: expect.stringContaining('invalid container listing'),
        }),
      )
      docker.appendListing(undefined)
      await until(() => adopted && !docker.containers.has('kurumi-agent-ghost'))
      expect(restarted.sessions.authenticate(token)).not.toBeNull()
    } finally {
      await restarted.stop()
    }
  },
)

test('a restarted host still adopts an agent that another container links to', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token, who, first } = await restartedHost(docker)
  docker.containers.get(first.dockerDriver.nameOf(who.containerId))?.links.push('linker/alias')
  const restarted = supervisedHost(docker)
  try {
    await restarted.sessions.start()
    await restarted.sessions.adopted()
    expect(restarted.sessions.authenticate(token)).not.toBeNull()
    expect(docker.commands('create')).toHaveLength(1)
  } finally {
    await restarted.stop()
  }
})

test('a container silent past the stale limit is reaped and the next line starts a new one', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const host = supervisedHost(docker, { staleAfterMs: 300, intervalMs: 10 })
  try {
    await host.sessions.start()
    await host.sessions.routeInbound(event('work'))
    const [token = ''] = tokens(docker)
    const { who } = await servedOnce(host, token)
    await Bun.sleep(200)
    await servedOnce(host, token)
    await Bun.sleep(200)
    expect(host.sessions.authenticate(token)).not.toBeNull()
    await until(() => host.sessions.authenticate(token) === null)
    expect(decisions(0)).toContainEqual(
      expect.objectContaining({ kind: 'session.container.reaped', reason: 'stale' }),
    )
    await until(
      () =>
        db.select().from(container).where(eq(container.id, who.containerId)).get() === undefined,
    )
    await host.sessions.routeInbound(event('after stale'))
    await until(() => docker.commands('create').length === 2)
  } finally {
    await host.stop()
  }
})

test('a restart with another image, port or network replaces the container instead of adopting it', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token, who } = await restartedHost(docker)
  const restartedAt = logs.length
  const restarted = supervisedHost(docker, { revision: 'rev-2' })
  try {
    await restarted.sessions.start()
    expect(restarted.sessions.authenticate(token)).toBeNull()
    expect(decisions(restartedAt)).toMatchObject([
      {
        kind: 'session.container.reaped',
        containerId: who.containerId,
        reason: expect.stringContaining('created for another runtime'),
      },
      { kind: 'session.adoption.done', adopted: 0, reaped: 1 },
    ])
    await until(() => docker.containers.size === 0)
    await restarted.sessions.routeInbound(event('after restart'))
    await until(() => docker.commands('create').length === 2)
    expect(
      flagValues(docker.commands('create')[1]?.args ?? [], '--label').filter((label) =>
        label.startsWith('kurumi.revision='),
      ),
    ).toEqual(['kurumi.revision=rev-2'])
  } finally {
    await restarted.stop()
  }
})

test('an adopted container keeps the tool deadline its runner declared before the restart', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const first = supervisedHost(docker)
  await first.sessions.start()
  await first.sessions.routeInbound(event('long tool'))
  const [token = ''] = tokens(docker)
  const { who } = await servedOnce(first, token)
  first.sessions.channel.heartbeat(who, { currentTool: 'build', toolTimeoutMs: 600_000 })
  await first.stop()
  const restarted = supervisedHost(docker, { staleAfterMs: 200, intervalMs: 20 })
  try {
    await restarted.sessions.start()
    await Bun.sleep(500)
    expect(restarted.sessions.authenticate(token)).not.toBeNull()
    expect(decisions(0)).not.toContainEqual(
      expect.objectContaining({ kind: 'session.container.reaped' }),
    )
  } finally {
    await restarted.stop()
  }
})

test('a slow create does not count as silence, because the clock starts again when the container runs', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const host = supervisedHost(docker, { staleAfterMs: 300, intervalMs: 10 })
  try {
    await host.sessions.start()
    docker.hold('create')
    const routed = host.sessions.routeInbound(event('slow'))
    await until(() => docker.commands('create').length === 1)
    await Bun.sleep(500)
    docker.release('create')
    await routed
    const [token = ''] = tokens(docker)
    await Bun.sleep(100)
    expect(host.sessions.authenticate(token)).not.toBeNull()
    expect(decisions(0)).not.toContainEqual(
      expect.objectContaining({ kind: 'session.container.reaped' }),
    )
  } finally {
    await host.stop()
  }
})

test('a host stall counts as at most a few intervals of silence, so a container that called just before it survives', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const host = supervisedHost(docker, { staleAfterMs: 600, intervalMs: 50 })
  try {
    await host.sessions.start()
    await host.sessions.routeInbound(event('work'))
    const [token = ''] = tokens(docker)
    await servedOnce(host, token)
    Bun.sleepSync(700)
    await Bun.sleep(120)
    expect(host.sessions.authenticate(token)).not.toBeNull()
    expect(decisions(0)).not.toContainEqual(
      expect.objectContaining({ kind: 'session.container.reaped' }),
    )
    await until(() => host.sessions.authenticate(token) === null)
  } finally {
    await host.stop()
  }
})

test('a lost events subscription resubscribes and its gap pass stops a container that appeared meanwhile', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const host = supervisedHost(docker)
  const watched = new Set([
    'session.events.lost',
    'session.events.subscribed',
    'session.container.stopped',
  ])
  try {
    await host.sessions.start()
    await until(() => decisions(0, watched).length === 1)
    docker.commands('events')[0]?.proc.complete({ code: 143 })
    await Bun.sleep(0)
    docker.add('kurumi-agent-late', {
      'kurumi.install': 'restart',
      'kurumi.role': 'agent',
      'kurumi.session': 'ses-late',
      'kurumi.container': 'ctr-late',
    })
    await until(() => docker.containers.size === 0 && decisions(0, watched).length === 4)
    expect(decisions(0, watched)).toMatchObject([
      { kind: 'session.events.subscribed', attempt: 0 },
      { kind: 'session.events.lost', code: 143, retryMs: 1000 },
      { kind: 'session.events.subscribed', attempt: 1 },
      { kind: 'session.container.stopped', name: 'kurumi-agent-late', reason: 'no live row' },
    ])
  } finally {
    await host.stop()
  }
})

test('the Agent Port waits for a listing that answers, so an earlier container is adopted, not refused', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  const { token } = await restartedHost(docker)
  docker.fail('ps')
  const restartedAt = logs.length
  const restarted = supervisedHost(docker, { intervalMs: 50 })
  let adopted = false
  try {
    await restarted.sessions.start()
    void restarted.sessions.adopted().then(
      () => {
        adopted = true
      },
      () => {},
    )
    await Bun.sleep(100)
    expect(adopted).toBe(false)
    expect(restarted.sessions.authenticate(token)).toBeNull()
    expect(decisions(restartedAt)).toEqual([])
    docker.recover('ps')
    await until(() => adopted)
    expect(restarted.sessions.authenticate(token)).not.toBeNull()
    expect(decisions(restartedAt)).toMatchObject([
      { kind: 'session.container.adopted' },
      { kind: 'session.adoption.done', adopted: 1 },
    ])
    expect(docker.commands('create')).toHaveLength(1)
  } finally {
    await restarted.stop()
  }
})

test('stopping the ledger rejects a pending adoption so nothing waits for it forever', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  docker.fail('ps')
  const host = supervisedHost(docker)
  await host.sessions.start()
  const pending = host.sessions.adopted().then(
    () => 'adopted',
    (error: unknown) => String(error),
  )
  await host.stop()
  expect(await pending).toContain('stopped')
})

test('a listing that gets no answer within the driver timeout fails the sweep instead of hanging startup', async () => {
  await ledger.stop()
  const docker = fakeDaemon()
  docker.hold('ps')
  const dockerDriver = createDockerDriver({
    install: 'restart',
    image: 'agent-test',
    cli: docker.daemon,
    timeoutMs: 30,
  })
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: {
      ...configured,
      driver: dockerDriver,
      supervision: { staleAfterMs: 60_000, intervalMs: 60_000 },
    },
    runtimeLog: (entry) => logs.push(entry),
  })
  try {
    await ledger.start()
    expect(logs.map((entry) => entry.kind)).toContain('session.reconcile.failed')
    expect(docker.commands('ps')[0]?.proc.killed).toBe(true)
  } finally {
    await Promise.all([ledger.stop(), dockerDriver.detach()])
  }
})

test('adopting a container ends the docker wait a dead host left for it and keeps its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-orphan-wait-'))
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\nif [ "$1" = wait ]; then echo $$ > "${dir}/$PPID-$2.pid"; while :; do sleep 0.05; done; fi\n`,
    { mode: 0o755 },
  )
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
  const dockerDriver = createDockerDriver({ install: 'orphan', image: 'agent-test' })
  const name = dockerDriver.nameOf('ctr-adopt')
  const unrelated = dockerDriver.nameOf('ctr-unrelated')
  const pids = (waited: string) =>
    readdirSync(dir)
      .filter((file) => file.endsWith(`-${waited}.pid`))
      .map((file) => ({
        own: file.startsWith(`${process.pid}-`),
        pid: Number(readFileSync(join(dir, file), 'utf8')),
      }))
  try {
    await Bun.spawn([
      'sh',
      '-c',
      `"${dir}/docker" wait ${name} >/dev/null 2>&1 & "${dir}/docker" wait ${unrelated} >/dev/null 2>&1 &`,
    ]).exited
    await until(() => pids(name).length === 1 && pids(unrelated).length === 1)
    expect(
      dockerDriver.adopt({
        dockerId: 'a'.repeat(64),
        name,
        role: 'agent',
        sessionId: 'ses-adopt',
        containerId: 'ctr-adopt',
        revision: null,
        state: 'running',
      }),
    ).toEqual({ ok: true })
    await until(() => pids(name).length === 2)
    const own = pids(name).find((entry) => entry.own)
    const orphan = pids(name).find((entry) => !entry.own)
    if (!own || !orphan) throw new Error('missing docker wait process')
    await until(() => !isAlive(orphan.pid))
    await Bun.sleep(100)
    expect(isAlive(own.pid)).toBe(true)
    expect(pids(unrelated).every((entry) => isAlive(entry.pid))).toBe(true)
  } finally {
    process.env.PATH = path
    for (const waited of [name, unrelated])
      for (const entry of pids(waited)) if (isAlive(entry.pid)) process.kill(entry.pid, 'SIGTERM')
    await dockerDriver.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
