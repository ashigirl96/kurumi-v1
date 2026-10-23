import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrations as accessMigrations } from '@kurumi/access/server'
import { createAgentLedger, migrations as agentMigrations } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db } from '@kurumi/rpc/server'
import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import type { ChannelAdapter, DeliveryTarget, InboundEvent, TerminalEvent } from './contract.ts'
import { messagingGroup, wiring } from './schema.ts'
import { createChatLedger, migrations, router } from './server.ts'

let sqlite: Database
let db: Db
let home: string
let agents: ReturnType<typeof createAgentLedger>
let ledger: ReturnType<typeof createChatLedger>
let agentId: string
let inbound: InboundEvent[]
let onInbound: (event: InboundEvent) => Promise<void>

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  db = drizzle(sqlite)
  for (const entry of [agentMigrations, accessMigrations, migrations]) {
    migrate(db, { migrationsFolder: entry.folder, migrationsTable: entry.table })
  }
  home = mkdtempSync(join(tmpdir(), 'kurumi-chat-'))
  agents = createAgentLedger({ db, home })
  agentId = agents.create({ name: 'work' }).id
  inbound = []
  onInbound = async () => {}
  ledger = createChatLedger({
    db,
    agentLedger: agents,
    sink: () => ({
      async onInbound(event) {
        transaction(db, (tx) => ledger.ensureTerminal(tx, event.platformId))
        inbound.push(event)
        await onInbound(event)
        return { sessionId: 'ses-shared', inboundId: event.messageId, seq: inbound.length }
      },
    }),
  })
})

afterEach(() => {
  ledger?.stop()
  sqlite.close()
  rmSync(home, { recursive: true, force: true })
})

function client(caller: Caller = { kind: 'host' }) {
  return createRouterClient(router, {
    context: {
      db,
      chatLedger: ledger,
      caller,
      guard: () => ({ kind: 'allow' }),
      grant: null,
    },
  })
}

function terminalTarget(id = agentId): DeliveryTarget {
  return { channel: 'terminal', instance: null, platformId: id, threadId: null }
}

function terminalAdapter(): ChannelAdapter {
  const adapter = ledger.adapter({ channel: 'terminal', instance: null })
  if (!adapter) throw new Error('terminal adapter missing')
  return adapter
}

async function follow(id = agentId, signal?: AbortSignal) {
  const events = ledger.terminal({ agentGroupId: id, text: 'hello', follow: true }, signal)
  const first = await events.next()
  expect(first.done).toBe(false)
  expect(first.value).toMatchObject({ kind: 'queued', sessionId: 'ses-shared' })
  return events
}

test('real migrations create access tables and repeated ensure reuses one group and wiring', () => {
  expect(
    sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'user_role') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: 'user' }, { name: 'user_role' }])
  const first = transaction(db, (tx) => ledger.ensureTerminal(tx, agentId))
  const second = transaction(db, (tx) => ledger.ensureTerminal(tx, agentId))
  expect(second).toEqual(first)
  expect(first).toEqual({
    messagingGroupId: expect.any(String),
    agentGroupId: agentId,
    mode: 'shared',
  })
  expect(db.select().from(messagingGroup).all()).toMatchObject([
    {
      id: first.messagingGroupId,
      channel: 'terminal',
      instance: '',
      platformId: agentId,
      isGroup: false,
    },
  ])
  expect(db.select().from(wiring).all()).toMatchObject([
    { messagingGroupId: first.messagingGroupId, agentGroupId: agentId, sessionMode: 'shared' },
  ])
  expect(ledger.targetOf(first.messagingGroupId, null)).toEqual(terminalTarget())
  expect(ledger.targetOf('mg-missing', null)).toBeNull()
})

test('caller rollback removes both terminal rows', () => {
  expect(() =>
    transaction(db, (tx) => {
      ledger.ensureTerminal(tx, agentId)
      throw new Error('caller rollback')
    }),
  ).toThrow('caller rollback')
  expect(db.select().from(messagingGroup).all()).toEqual([])
  expect(db.select().from(wiring).all()).toEqual([])
})

test('unknown agents are rejected before creating rows or invoking the inbound sink', async () => {
  expect(() => transaction(db, (tx) => ledger.ensureTerminal(tx, 'ag-missing'))).toThrow(/agent/i)
  await rejects(
    client()
      .terminal({ agentGroupId: 'ag-missing', text: 'hello', follow: true })
      .then(async (events) => events.next()),
    /agent/i,
  )
  expect(inbound).toEqual([])
  expect(db.select().from(messagingGroup).all()).toEqual([])
  expect(db.select().from(wiring).all()).toEqual([])
  await rejects(terminalAdapter().post(terminalTarget('ag-missing'), { id: 'out-no', text: 'no' }))
})

test('database uniqueness rejects duplicate normalized groups and wirings', () => {
  transaction(db, (tx) => ledger.ensureTerminal(tx, agentId))
  const group = db.select().from(messagingGroup).get()
  const link = db.select().from(wiring).get()
  if (!group || !link) throw new Error('terminal rows missing')
  expect(() =>
    transaction(db, (tx) => {
      tx.insert(messagingGroup)
        .values({ ...group, id: 'mg-duplicate' })
        .run()
    }),
  ).toThrow(/UNIQUE/)
  expect(() =>
    transaction(db, (tx) => {
      tx.insert(wiring)
        .values({ ...link, id: 'wir-duplicate' })
        .run()
    }),
  ).toThrow(/UNIQUE/)
  expect(() =>
    transaction(db, (tx) => {
      tx.insert(wiring)
        .values({ ...link, id: 'wir-invalid', agentGroupId: 'ag-missing' })
        .run()
    }),
  ).toThrow(/FOREIGN KEY/)
})

test('oRPC preserves exact text and defaults to a receipt-only iterator', async () => {
  const text = `  日本語 🐈\t\r\0${'x'.repeat(100_000)}  `
  const before = performance.now()
  const events = await client().terminal({ agentGroupId: agentId, text })
  const first = await events.next()
  const event = inbound[0]
  if (!event) throw new Error('inbound missing')
  expect(event).toEqual({
    channel: 'terminal',
    instance: null,
    platformId: agentId,
    threadId: null,
    messageId: expect.any(String),
    receivedAt: expect.any(Number),
    text,
    sender: { handle: 'terminal:owner', displayName: 'Owner', isBot: false },
    isMention: true,
    isGroup: false,
    attachments: [],
  })
  expect(event.receivedAt).toBeGreaterThanOrEqual(before)
  expect(event.receivedAt).toBeLessThanOrEqual(performance.now())
  expect(first).toEqual({
    done: false,
    value: { kind: 'queued', sessionId: 'ses-shared', inboundId: event.messageId, seq: 1 },
  })
  expect(await events.next()).toEqual({ done: true, value: undefined })
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-none', text: 'no listeners' }))
})

test('follow registers before routing and yields the receipt before immediate replies', async () => {
  onInbound = async () => {
    expect(
      await terminalAdapter().post(terminalTarget(), {
        id: 'out-immediate',
        text: '  reply\r\0猫  ',
      }),
    ).toEqual({ platformMessageId: 'out-immediate' })
  }
  const events = await client().terminal({ agentGroupId: agentId, text: 'hello', follow: true })
  expect((await events.next()).value).toMatchObject({ kind: 'queued' })
  expect(await events.next()).toEqual({
    done: false,
    value: { kind: 'reply', outboundId: 'out-immediate', text: '  reply\r\0猫  ' },
  })
  await events.return?.()
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-closed', text: 'closed' }))
})

test('two followers receive each reply once while receipt-only calls add no subscribers', async () => {
  const first = await follow()
  const second = await follow()
  const otherId = agents.create({ name: 'home' }).id
  const other = await follow(otherId)
  for (let i = 0; i < 3; i++) {
    const oneShot = ledger.terminal({ agentGroupId: agentId, text: `line ${i}`, follow: false })
    expect((await oneShot.next()).value).toMatchObject({ kind: 'queued' })
    expect((await oneShot.next()).done).toBe(true)
  }
  await terminalAdapter().post(terminalTarget(), { id: 'out-shared', text: 'shared reply' })
  const reply = {
    done: false,
    value: { kind: 'reply', outboundId: 'out-shared', text: 'shared reply' },
  } satisfies IteratorYieldResult<TerminalEvent>
  expect(await first.next()).toEqual(reply)
  expect(await second.next()).toEqual(reply)
  await terminalAdapter().post(terminalTarget(otherId), { id: 'out-other', text: 'other reply' })
  expect((await other.next()).value).toEqual({
    kind: 'reply',
    outboundId: 'out-other',
    text: 'other reply',
  })
  await first.return()
  await second.return()
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-no-followers', text: 'none' }))
  await other.return()
})

test('abort wakes a parked next and removes its subscription', async () => {
  const controller = new AbortController()
  const events = await follow(agentId, controller.signal)
  const pending = events.next()
  controller.abort()
  expect((await pending).done).toBe(true)
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-after-abort', text: 'none' }))
})

test('return closes a parked router iterator without a separate abort signal', async () => {
  const events = await client().terminal({ agentGroupId: agentId, text: 'hello', follow: true })
  await events.next()
  const pending = events.next()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const returning = events.return?.()
  const deadline = Promise.withResolvers<string>()
  const timer = setTimeout(() => deadline.resolve('return timed out'), 100)
  try {
    expect(await Promise.race([returning, deadline.promise])).toEqual({
      done: true,
      value: undefined,
    })
    expect((await pending).done).toBe(true)
    await rejects(
      terminalAdapter().post(terminalTarget(), { id: 'out-after-return', text: 'none' }),
    )
  } finally {
    clearTimeout(timer)
    ledger.stop()
    await returning
    await pending
  }
})

test('already aborted requests do not route or write', async () => {
  const controller = new AbortController()
  controller.abort()
  const events = ledger.terminal(
    { agentGroupId: agentId, text: 'cancelled', follow: true },
    controller.signal,
  )
  expect((await events.next()).done).toBe(true)
  expect(inbound).toEqual([])
  expect(db.select().from(messagingGroup).all()).toEqual([])
})

test('routing failure removes the pre-registered subscriber', async () => {
  onInbound = async () => {
    throw new Error('route failed')
  }
  const events = ledger.terminal({ agentGroupId: agentId, text: 'hello', follow: true })
  await rejects(events.next(), /route failed/)
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-failed', text: 'none' }))
})

test('stop completes parked followers and refuses further delivery', async () => {
  const events = await follow()
  const pending = events.next()
  ledger.stop()
  expect((await pending).done).toBe(true)
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-stopped', text: 'none' }))
})

test('overflow terminates the slow follower without dropping replies for the fast follower', async () => {
  const slow = await follow()
  const fast = await follow()
  for (let i = 0; i < 257; i++) {
    const pending = fast.next()
    const id = `out-${i}`
    await terminalAdapter().post(terminalTarget(), { id, text: `reply ${i}` })
    expect((await pending).value).toEqual({ kind: 'reply', outboundId: id, text: `reply ${i}` })
  }
  await rejects(slow.next(), /overflow/i)
  await fast.return()
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-none', text: 'none' }))
})

test('adapter selection and delivery never fall back to another terminal target', async () => {
  const events = await follow()
  expect(ledger.adapter({ channel: 'slack', instance: null })).toBeNull()
  expect(ledger.adapter({ channel: 'terminal', instance: 'other' })).toBeNull()
  for (const target of [
    { ...terminalTarget(), channel: 'slack' },
    { ...terminalTarget(), instance: 'other' },
    { ...terminalTarget(), threadId: 'thread' },
  ]) {
    await rejects(terminalAdapter().post(target, { id: 'out-wrong', text: 'wrong' }))
  }
  await terminalAdapter().post(terminalTarget(), { id: 'out-right', text: 'right' })
  expect((await events.next()).value).toEqual({
    kind: 'reply',
    outboundId: 'out-right',
    text: 'right',
  })
  await events.return()
})

test.each<Caller>([
  { kind: 'human', userId: 'user-owner' },
  { kind: 'agent', agentGroupId: 'ag-caller', sessionId: 'ses-caller' },
])('non-host callers cannot open terminal chat (%j)', async (caller) => {
  await rejects(
    client(caller)
      .terminal({ agentGroupId: agentId, text: 'hello', follow: true })
      .then((events) => events.next()),
    { code: 'FORBIDDEN' },
  )
  expect(inbound).toEqual([])
  expect(db.select().from(messagingGroup).all()).toEqual([])
  expect(db.select().from(wiring).all()).toEqual([])
  await rejects(terminalAdapter().post(terminalTarget(), { id: 'out-denied', text: 'none' }))
})
