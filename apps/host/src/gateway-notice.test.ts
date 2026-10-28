import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountLedger } from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'
import { createAgentLedger } from '@kurumi/agent/server'
import { createChatLedger, migrations as chatMigrations } from '@kurumi/chat/server'
import { egressAllowance } from '@kurumi/gateway/schema'
import {
  ALLOWANCE_MS,
  createEgressApproval,
  migrations,
  type SessionNotice,
} from '@kurumi/gateway/server'
import { inboundMessage, outboundMessage } from '@kurumi/session/schema'
import { createSessionLedger, migrations as sessionMigrations } from '@kurumi/session/server'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

let db: ReturnType<typeof inMemoryDb>
let home: string
let sessions: ReturnType<typeof createSessionLedger>
let chat: ReturnType<typeof createChatLedger>
let at: number
let queue: (key: string) => void
let kick: (key: string) => void
let kicks: string[]
let errors: string[]

beforeEach(() => {
  db = inMemoryDb()
  for (const { folder, table } of [chatMigrations, sessionMigrations, migrations]) {
    migrate(db, { migrationsFolder: folder, migrationsTable: table })
  }
  home = mkdtempSync(join(tmpdir(), 'kurumi-gateway-notice-'))
  insertAgentGroup(db, 'g1')
  const agents = createAgentLedger({ db, home })
  chat = createChatLedger({
    db,
    agentLedger: agents,
    sink: () => ({ onInbound: (input) => sessions.routeInbound(input) }),
  })
  sessions = createSessionLedger({ db, agentLedger: agents, chatLedger: chat })
  db.$client.run(`INSERT INTO session (id, agent_group_id, mode, status, last_active_at, created_at)
    VALUES ('s1', 'g1', 'shared', 'active', 0, 0)`)
  at = 1_800_000_000_000
  queue = () => {}
  kick = () => {}
  kicks = []
  errors = []
})

afterEach(async () => {
  await sessions.stop()
  chat.stop()
  db.$client.close()
  rmSync(home, { recursive: true, force: true })
})

function gate(now = () => at) {
  return createEgressApproval({
    db,
    accounts: createAccountLedger({ db, vaultKey: Buffer.alloc(32) }),
    approvals: {
      request: () => {
        throw new Error('unexpected approval request')
      },
    },
    queueNotice(tx, notice) {
      queue(notice.key)
      return sessions.queueNotice(tx, notice)
    },
    deliverNotice(notice: SessionNotice) {
      kicks.push(notice.key)
      kick(notice.key)
      sessions.deliverNotice(notice)
    },
    log: (event) => errors.push(event.approvalId),
    now,
  })
}

function allowance(overrides: Partial<typeof egressAllowance.$inferInsert> = {}) {
  const row = {
    approvalId: 'apr-1',
    agentGroupId: 'g1',
    sessionId: 's1',
    ruleId: 'rul-1',
    accountHandle: 'anthropic/main',
    method: 'POST',
    host: 'api.anthropic.com',
    pathWithoutQuery: '/v1/messages',
    fingerprint: Buffer.from('request'),
    state: 'pending',
    createdAt: new Date(at),
    ...overrides,
  }
  db.$client.run(
    `INSERT INTO egress_allowance
    (approval_id, agent_group_id, session_id, rule_id, account_handle, method, host, path, fingerprint, state, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.approvalId,
      row.agentGroupId,
      row.sessionId,
      row.ruleId,
      row.accountHandle,
      row.method,
      row.host,
      row.pathWithoutQuery,
      row.fingerprint,
      row.state,
      row.createdAt.getTime(),
      row.expiresAt?.getTime() ?? null,
      row.usedAt?.getTime() ?? null,
    ],
  )
}

test('a post-grant queue failure rolls both notice messages back and recovers once without extending expiry', async () => {
  allowance()
  db.$client.run(`CREATE TRIGGER notify_fault BEFORE INSERT ON outbound_message
    BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END`)
  const approval = gate()
  const expiresAt = new Date(at + ALLOWANCE_MS)
  await rejects(approval.decided({ id: 'apr-1' }, 'approve'), /injected queue failure/)
  expect(db.select().from(inboundMessage).all()).toEqual([])
  expect(db.select().from(outboundMessage).all()).toEqual([])
  const granted = db.select().from(egressAllowance).all()
  expect(granted[0]?.expiresAt).toEqual(new Date(at + ALLOWANCE_MS))
  db.$client.run('DROP TRIGGER notify_fault')
  at += 60_000

  approval.recoverNotices()
  gate().recoverNotices()
  await approval.decided({ id: 'apr-1' }, 'approve')

  expect(db.select().from(egressAllowance).all()).toEqual(granted)
  expect(db.select().from(inboundMessage).all()).toMatchObject([
    {
      id: 'ntf-apr-1',
      kind: 'system',
      trigger: true,
      content: expect.stringContaining(expiresAt.toISOString()),
    },
  ])
  expect(db.select().from(outboundMessage).all()).toHaveLength(1)
  expect(errors).toEqual([])
})

test('a committed notice whose delivery kick failed is kicked again on a duplicate receipt', async () => {
  allowance()
  kick = () => {
    throw new Error('injected delivery kick failure')
  }
  await rejects(gate().decided({ id: 'apr-1' }, 'approve'), /injected delivery kick failure/)
  expect(db.select().from(inboundMessage).all()).toHaveLength(1)
  const granted = db.select().from(egressAllowance).all()
  kick = () => {}

  gate().recoverNotices()
  gate().recoverNotices()

  expect(kicks).toEqual(['apr-1', 'apr-1', 'apr-1'])
  expect(db.select().from(inboundMessage).all()).toHaveLength(1)
  expect(db.select().from(outboundMessage).all()).toHaveLength(1)
  expect(db.select().from(egressAllowance).all()).toEqual(granted)
})

test('one failed candidate does not block another notice or discard its own durable grant', () => {
  allowance({ state: 'granted', expiresAt: new Date(at + ALLOWANCE_MS) })
  allowance({ approvalId: 'apr-2', state: 'granted', expiresAt: new Date(at + ALLOWANCE_MS) })
  queue = (key) => {
    if (key === 'apr-1') throw new Error('injected row failure')
  }
  const granted = db.select().from(egressAllowance).all()

  gate().recoverNotices()

  expect(errors).toEqual(['apr-1'])
  expect(kicks).toEqual(['apr-2'])
  expect(db.select().from(egressAllowance).all()).toEqual(granted)
  queue = () => {}
  gate().recoverNotices()
  expect(db.select().from(inboundMessage).all()).toHaveLength(2)
})

test('missing and closed sessions do not queue or kick a notice', () => {
  insertAgentGroup(db, 'g2')
  db.$client.run(`INSERT INTO session (id, agent_group_id, mode, status, last_active_at, created_at)
    VALUES ('closed', 'g2', 'shared', 'closed', 0, 0)`)
  for (const id of ['missing', 'closed']) {
    allowance({
      approvalId: `apr-${id}`,
      sessionId: id,
      state: 'granted',
      expiresAt: new Date(at + ALLOWANCE_MS),
    })
  }

  gate().recoverNotices()

  expect(kicks).toEqual([])
  expect(db.select().from(inboundMessage).all()).toEqual([])
  expect(db.select().from(outboundMessage).all()).toEqual([])
})

test('recovery skips pending, denied, used and expired allowances without renewing capability', () => {
  allowance()
  allowance({ approvalId: 'denied', state: 'denied' })
  allowance({
    approvalId: 'used',
    state: 'used',
    expiresAt: new Date(at + ALLOWANCE_MS),
    usedAt: new Date(at),
  })
  allowance({ approvalId: 'expired', state: 'granted', expiresAt: new Date(at - 1) })
  allowance({ approvalId: 'boundary', state: 'granted', expiresAt: new Date(at) })
  const original = db.select().from(egressAllowance).all()

  gate().recoverNotices()

  expect(kicks).toEqual([])
  expect(db.select().from(inboundMessage).all()).toEqual([])
  expect(db.select().from(egressAllowance).all()).toEqual(original)
})

test('eligibility is checked again inside the notice transaction', () => {
  const expiry = at + ALLOWANCE_MS
  allowance({ state: 'granted', expiresAt: new Date(expiry) })
  let reads = 0

  gate(() => (++reads === 1 ? at : expiry)).recoverNotices()

  expect(reads).toBe(2)
  expect(kicks).toEqual([])
  expect(db.select().from(inboundMessage).all()).toEqual([])
})
