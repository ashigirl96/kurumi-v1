import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLedger, migrations as agentMigrations } from '@kurumi/agent/server'
import { messagingGroup, wiring } from '@kurumi/chat/schema'
import {
  createChatLedger,
  migrations as chatMigrations,
  type InboundEvent,
} from '@kurumi/chat/server'
import { startAgentPort } from '@kurumi/gateway/server'
import { guardRouter, transaction, type Db, type KurumiContext } from '@kurumi/rpc/server'
import { RPCHandler } from '@orpc/server/node'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { container, inboundMessage, outboundMessage, session } from './schema.ts'
import {
  createSessionLedger,
  migrations,
  router,
  type InboundLog,
  type SessionLedger,
  type SessionRuntime,
} from './server.ts'
import { createFakeDriver } from './testing.ts'

let sqlite: Database
let db: Db
let home: string
let agents: ReturnType<typeof createAgentLedger>
let chat: ReturnType<typeof createChatLedger>
let ledger: SessionLedger
let agentId: string
let logs: InboundLog[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kurumi-session-'))
  sqlite = new Database(join(home, 'test.db'))
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
  logs = []
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    log: (entry) => logs.push(entry),
  })
})

afterEach(async () => {
  await ledger?.stop()
  chat?.stop()
  sqlite?.close()
  rmSync(home, { recursive: true, force: true })
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

function runtime(driver = createFakeDriver()): SessionRuntime {
  return {
    driver,
    image: 'kurumi-test',
    egress: {
      admission: () => ({ open: true }),
      contribution: () => ({
        env: { KURUMI_URL: 'http://host.test' },
        mounts: [],
        network: { kind: 'default' },
      }),
    },
  }
}

async function channelServer() {
  const driver = createFakeDriver()
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: runtime(driver),
  })
  type Context = KurumiContext & {
    sessionLedger: SessionLedger
    agentPrincipal: ReturnType<SessionLedger['authenticate']>
    requestSignal: AbortSignal
  }
  const handler = new RPCHandler(guardRouter<Context>().router({ session: router }))
  const port = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => ledger.authenticate(token),
    intercepts: () => false,
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
    async rpc(request, response, principal, signal) {
      const result = await handler.handle(request, response, {
        prefix: '/rpc',
        context: {
          db,
          sessionLedger: ledger,
          caller: { kind: 'agent', ...principal },
          agentPrincipal: principal,
          requestSignal: signal,
          grant: null,
          guard: () => ({ kind: 'allow' }),
        },
      })
      if (!result.matched) response.writeHead(404).end()
    },
  })
  return {
    driver,
    stop: () => port.stop(),
    pull: (token: string, input: unknown = { waitMs: 0 }) =>
      fetch(`http://127.0.0.1:${port.port}/rpc/session/channel/pull`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ json: input }),
      }),
  }
}

test('a parked pull returns within 50 ms of inbound arrival', async () => {
  const driver = createFakeDriver()
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: runtime(driver),
  })
  const first = await ledger.routeInbound(event('first'))
  const principal = ledger.authenticate(driver.runs[0]?.env.KURUMI_TOKEN ?? '')
  if (!principal) throw new Error('missing live container')
  await ledger.channel.pull(principal, { waitMs: 0 })
  await ledger.channel.complete(principal, { ids: [first.inboundId] })
  let returned = false
  const parked = ledger.channel.pull(principal, { waitMs: 500 }).then((result) => {
    returned = true
    return { result, returnedAt: performance.now() }
  })
  await Bun.sleep(10)
  expect(returned).toBe(false)
  const incoming = event('wake up')
  const accepted = await ledger.routeInbound(incoming)
  const { result, returnedAt } = await parked
  expect(result.messages.map((message) => message.id)).toEqual([accepted.inboundId])
  expect(returnedAt - incoming.receivedAt).toBeLessThanOrEqual(50)
})

test('a reaped container token receives HTTP 401 on pull', async () => {
  const host = await channelServer()
  try {
    await ledger.routeInbound(event('first'))
    const spec = host.driver.runs[0]
    const token = spec?.env.KURUMI_TOKEN
    if (!spec || !token) throw new Error('missing live container')
    const before = await host.pull(token)
    expect(before.status).toBe(200)
    await before.body?.cancel()
    await host.driver.kill(spec.containerId, 0)
    const deadline = performance.now() + 1000
    while (db.select().from(container).where(eq(container.id, spec.containerId)).get()) {
      if (performance.now() > deadline) throw new Error('container was not reaped')
      await Bun.sleep(1)
    }
    const after = await host.pull(token)
    expect(after.status).toBe(401)
    await after.body?.cancel()
  } finally {
    await host.stop()
  }
})

test('another session token cannot pull its pending rows over HTTP', async () => {
  const host = await channelServer()
  try {
    const first = await ledger.routeInbound(event('work message'))
    const workToken = host.driver.runs[0]?.env.KURUMI_TOKEN
    const principal = ledger.authenticate(workToken ?? '')
    if (!workToken || !principal) throw new Error('missing work container')
    await ledger.channel.pull(principal, { waitMs: 0 })
    await ledger.channel.complete(principal, { ids: [first.inboundId] })
    const other = agents.create({ name: 'home' }).id
    const second = await ledger.routeInbound(event('home message', other))
    const homeToken = host.driver.runs[1]?.env.KURUMI_TOKEN
    if (!homeToken) throw new Error('missing home container')
    expect(homeToken).not.toBe(workToken)
    const crossSession = await host.pull(workToken, { waitMs: 0, sessionId: second.sessionId })
    expect(crossSession.status).toBe(400)
    await crossSession.body?.cancel()
    const workPull = await host.pull(workToken)
    expect(workPull.status).toBe(200)
    expect(await workPull.json()).toEqual({ json: { messages: [] } })
    expect(
      db.select().from(inboundMessage).where(eq(inboundMessage.id, second.inboundId)).get(),
    ).toMatchObject({ status: 'pending', claimedBy: null })
    const homePull = await host.pull(homeToken)
    expect(homePull.status).toBe(200)
    expect(await homePull.json()).toMatchObject({
      json: { messages: [{ id: second.inboundId, content: 'home message' }] },
    })
  } finally {
    await host.stop()
  }
})

test('shared sessions persist exact pending messages and resume sequence after reopening SQLite', async () => {
  const text = `  日本語 🐈\t\r\0${'x'.repeat(100_000)}  `
  const first = await ledger.routeInbound(event(text))
  const second = await ledger.routeInbound(event('second'))
  expect(second.sessionId).toBe(first.sessionId)
  expect([first.seq, second.seq]).toEqual([1, 2])
  expect(db.select().from(session).all()).toHaveLength(1)
  expect(db.select().from(inboundMessage).all()).toMatchObject([
    { id: first.inboundId, seq: 1, content: text, status: 'pending' },
    { id: second.inboundId, seq: 2, content: 'second', status: 'pending' },
  ])
  expect(db.select().from(container).all()).toEqual([])
  sqlite.close()
  sqlite = new Database(join(home, 'test.db'))
  sqlite.run('PRAGMA foreign_keys = ON')
  db = drizzle(sqlite)
  agents = createAgentLedger({ db, home })
  chat.stop()
  chat = createChatLedger({
    db,
    agentLedger: agents,
    sink: () => ({ onInbound: (input) => ledger.routeInbound(input) }),
  })
  ledger = createSessionLedger({ db, agentLedger: agents, chatLedger: chat })
  expect(await ledger.routeInbound(event('third'))).toMatchObject({
    sessionId: first.sessionId,
    seq: 3,
  })
  expect(db.select().from(inboundMessage).all()).toHaveLength(3)
})

test('unknown agents leave all routing tables empty', async () => {
  await rejects(ledger.routeInbound(event('no', 'ag-missing')), /agent/i)
  for (const table of [session, inboundMessage, messagingGroup, wiring, container]) {
    expect(db.select().from(table).all()).toEqual([])
  }
})

test('event retries do not consume sequence or overwrite content and other agents have separate sessions', async () => {
  const input = event('original')
  const first = await ledger.routeInbound(input)
  expect(await ledger.routeInbound(input)).toEqual(first)
  await rejects(ledger.routeInbound({ ...input, text: 'changed' }), /conflict|different/i)
  const next = await ledger.routeInbound(event('next'))
  expect(next.seq).toBe(2)
  const other = agents.create({ name: 'home' }).id
  const separate = await ledger.routeInbound(event('other', other))
  expect(separate.sessionId).not.toBe(first.sessionId)
  expect(separate.seq).toBe(1)
})

test('concurrent lines reserve one runtime and persist only a hash of its token', async () => {
  const driver = createFakeDriver()
  const gate = Promise.withResolvers<void>()
  driver.beforeRun = () => gate.promise
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: runtime(driver),
  })
  const first = ledger.routeInbound(event('first'))
  const second = ledger.routeInbound(event('second'))
  expect(driver.runs).toHaveLength(1)
  expect(db.select().from(inboundMessage).all()).toHaveLength(2)
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  expect(b).toMatchObject({ sessionId: a.sessionId, seq: 2 })
  const spec = driver.runs[0]
  const row = db.select().from(container).get()
  if (!spec || !row) throw new Error('runtime did not start')
  const token = spec.env.KURUMI_TOKEN
  if (!token) throw new Error('Session Token missing')
  expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  expect(row.tokenHash).toEqual(createHash('sha256').update(token).digest())
  expect(JSON.stringify(db.select().from(container).all())).not.toContain(token)
  expect((await Bun.file(join(home, 'test.db')).text()).includes(token)).toBe(false)
  expect(ledger.authenticate(token)).toMatchObject({
    containerId: row.id,
    sessionId: a.sessionId,
    agentGroupId: agentId,
  })
  expect(ledger.authenticate('invalid')).toBeNull()
  transaction(db, (tx) => {
    tx.delete(container).where(eq(container.id, row.id)).run()
  })
  expect(ledger.authenticate(token)).toBeNull()
})

test('closed admission keeps inbound pending and failed startup revokes its token before a retry', async () => {
  const driver = createFakeDriver()
  const configured = runtime(driver)
  configured.egress.admission = () => ({
    open: false,
    reason: 'probing',
    detail: 'waiting',
    since: new Date(),
  })
  ledger = createSessionLedger({ db, agentLedger: agents, chatLedger: chat, runtime: configured })
  await ledger.routeInbound(event('closed'))
  expect(driver.runs).toHaveLength(0)
  configured.egress.admission = () => ({ open: true })
  driver.result = { ok: false, reason: 'cannot start' }
  const accepted = await ledger.routeInbound(event('failed'))
  const failedToken = driver.runs[0]?.env.KURUMI_TOKEN
  if (!failedToken) throw new Error('missing failed run')
  expect(ledger.authenticate(failedToken)).toBeNull()
  expect(db.select().from(container).all()).toEqual([])
  expect(db.select().from(inboundMessage).all()).toHaveLength(2)
  driver.result = { ok: true }
  expect(await ledger.routeInbound(event('retry'))).toMatchObject({
    sessionId: accepted.sessionId,
    seq: 3,
  })
  expect(driver.runs).toHaveLength(2)
})

test('outbound is delivered through the bound terminal and duplicate posts do not broadcast twice', async () => {
  const stream = chat.terminal({ agentGroupId: agentId, text: 'hello', follow: true })
  const queued = (await stream.next()).value
  if (!queued || queued.kind !== 'queued') throw new Error('missing queued receipt')
  const post = { id: 'out-one', sessionId: queued.sessionId, text: 'reply 🐈' }
  await ledger.postOutbound(post)
  expect((await stream.next()).value).toEqual({
    kind: 'reply',
    outboundId: post.id,
    text: post.text,
  })
  await ledger.postOutbound(post)
  expect(db.select().from(outboundMessage).all()).toMatchObject([
    { id: post.id, seq: 1, status: 'delivered', attempts: 1, platformMessageId: post.id },
  ])
  await rejects(ledger.postOutbound({ ...post, text: 'changed' }), /conflict|different/i)
  await stream.return()
  await ledger.postOutbound({ ...post, id: 'out-offline' })
  expect(
    db.select().from(outboundMessage).where(eq(outboundMessage.id, 'out-offline')).get(),
  ).toMatchObject({ status: 'failed', attempts: 1 })
})

test('database uniqueness treats null session keys as a single absent value', async () => {
  await ledger.routeInbound(event('hello'))
  const row = db.select().from(session).get()
  if (!row) throw new Error('missing session')
  expect(() =>
    transaction(db, (tx) => {
      tx.insert(session)
        .values({ ...row, id: 'ses-duplicate' })
        .run()
    }),
  ).toThrow(/UNIQUE/)
  transaction(db, (tx) => {
    tx.insert(session)
      .values({ ...row, id: 'ses-unbound', messagingGroupId: null, mode: 'agent-shared' })
      .run()
  })
  expect(() =>
    transaction(db, (tx) => {
      tx.insert(session)
        .values({
          ...row,
          id: 'ses-unbound-duplicate',
          messagingGroupId: null,
          mode: 'agent-shared',
        })
        .run()
    }),
  ).toThrow(/UNIQUE/)
})

test('receive and commit log records share the persisted inbound id and monotonic time', async () => {
  const input = event('hello')
  const receipt = await ledger.routeInbound(input)
  expect(logs).toEqual([
    {
      kind: 'session.inbound.received',
      inboundId: receipt.inboundId,
      monotonicMs: input.receivedAt,
    },
    {
      kind: 'session.inbound.committed',
      inboundId: receipt.inboundId,
      monotonicMs: expect.any(Number),
    },
  ])
  expect(logs[1]?.monotonicMs).toBeGreaterThanOrEqual(input.receivedAt)
})

test('a throwing driver preserves its accepted receipt and revokes the starting token', async () => {
  const driver = createFakeDriver()
  driver.beforeRun = async () => {
    throw new Error('runtime unavailable')
  }
  ledger = createSessionLedger({
    db,
    agentLedger: agents,
    chatLedger: chat,
    runtime: runtime(driver),
  })
  const receipt = await ledger.routeInbound(event('accepted'))
  expect(receipt.seq).toBe(1)
  expect(db.select().from(inboundMessage).get()).toMatchObject({
    id: receipt.inboundId,
    status: 'pending',
  })
  expect(db.select().from(container).all()).toEqual([])
  const token = driver.runs[0]?.env.KURUMI_TOKEN
  if (!token) throw new Error('missing attempted runtime')
  expect(ledger.authenticate(token)).toBeNull()
})
