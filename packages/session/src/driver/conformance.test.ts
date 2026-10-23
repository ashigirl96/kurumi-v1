import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
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
import { createDockerDriver } from './docker.ts'
import { FakeCli } from './fake-cli.ts'

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
