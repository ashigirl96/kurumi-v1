import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { user } from '@kurumi/access/schema'
import {
  createAccessLedger,
  HOST_OWNER,
  migrations as accessMigrations,
  router as accessRouter,
  type AccessLedger,
} from '@kurumi/access/server'
import { migrations as agentMigrations } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import {
  callByPath,
  guardRouter,
  transaction,
  type ApprovalGrant,
  type Db,
  type KurumiContext,
} from '@kurumi/rpc/server'
import { createRouterClient } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { pendingApproval } from './schema.ts'
import {
  createApprovalLedger,
  migrations,
  router as approvalRouter,
  type ApprovalDecision,
  type ApprovalHandlers,
  type ApprovalLedger,
  type ApprovalRecord,
} from './server.ts'

const agent = { kind: 'agent', agentGroupId: 'ag-a', sessionId: 'session-a' } as const
const host: Caller = { kind: 'host' }

let home: string
const open: Database[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kurumi-approval-'))
})

afterEach(() => {
  for (const sqlite of open.splice(0)) sqlite.close()
  rmSync(home, { recursive: true, force: true })
})

function openDb(): Db {
  const sqlite = new Database(join(home, 'kurumi.db'))
  open.push(sqlite)
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const { folder, table } of [agentMigrations, accessMigrations, migrations]) {
    migrate(db, { migrationsFolder: folder, migrationsTable: table })
  }
  db.run(
    sql`INSERT OR IGNORE INTO agent_group (id, name, folder, created_at) VALUES ('ag-a', 'a', 'a', 0)`,
  )
  return db
}

type Handled = { id: string; decision: ApprovalDecision }

function recordingLedger(db: Db, fail = false) {
  const handled: Handled[] = []
  const record = (approval: ApprovalRecord, decision: ApprovalDecision) => {
    handled.push({ id: approval.id, decision })
    return fail ? Promise.reject(new Error('handler crashed')) : Promise.resolve()
  }
  const accessLedger = createAccessLedger({ db })
  const ledger = createApprovalLedger({
    db,
    accessLedger,
    handlers: () => ({ procedure: record, 'gateway.request': record }),
  })
  return { ledger, accessLedger, handled }
}

function requestProcedure(db: Db, ledger: ApprovalLedger): string {
  return transaction(
    db,
    (tx) =>
      ledger.request(tx, {
        kind: 'procedure',
        agentGroupId: agent.agentGroupId,
        sessionId: agent.sessionId,
        title: 'access.users.create',
        body: ['Agent asks to create slack:U1'],
        payload: { path: ['access', 'users', 'create'], input: {}, caller: agent },
      }).approvalId,
  )
}

function grantAdmin(db: Db, userId: string, agentGroupId: string) {
  db.run(
    sql`INSERT OR IGNORE INTO user (id, kind, display_name) VALUES (${userId}, 'slack', ${userId})`,
  )
  db.run(
    sql`INSERT INTO user_role (user_id, role, agent_group_id, granted_by, granted_at) VALUES (${userId}, 'admin', ${agentGroupId}, 'host', 0)`,
  )
}

test('a request stores a pending approval with the approver chain baked in', () => {
  const db = openDb()
  grantAdmin(db, 'slack:admin', 'ag-a')
  const { ledger } = recordingLedger(db)

  const id = requestProcedure(db, ledger)

  expect(id).toMatch(/^apr-[0-9a-f-]{36}$/)
  expect(ledger.show(id)).toMatchObject({
    id,
    kind: 'procedure',
    status: 'pending',
    agentGroupId: 'ag-a',
    sessionId: 'session-a',
    title: 'access.users.create',
    approvers: ['slack:admin', HOST_OWNER],
  })
  expect(ledger.list('pending').map((approval) => approval.id)).toEqual([id])
  expect(ledger.list('decided')).toEqual([])
})

test.each([
  ['approve', 'approved'],
  ['deny', 'denied'],
] as const)(
  '%s decides once, runs the handler, and records it as handled',
  async (decision, status) => {
    const db = openDb()
    const { ledger, handled } = recordingLedger(db)
    const id = requestProcedure(db, ledger)

    const result = await ledger.decide({ id, decision, by: host })

    expect(result).toMatchObject({ changed: true, approval: { status, decidedBy: HOST_OWNER } })
    expect(result.message).toStartWith(`${status} by host at `)
    expect(handled).toEqual([{ id, decision }])
    expect(ledger.show(id)).toMatchObject({ status, handledAt: expect.any(Date) })
    expect(ledger.list('decided').map((approval) => approval.id)).toEqual([id])
  },
)

test('a second decision changes nothing, says who decided, and does not rerun the handler', async () => {
  const db = openDb()
  const { ledger, handled } = recordingLedger(db)
  const id = requestProcedure(db, ledger)
  await ledger.decide({ id, decision: 'approve', by: host })
  const first = ledger.show(id)

  const second = await ledger.decide({ id, decision: 'deny', by: host })

  expect(second.changed).toBe(false)
  expect(second.message).toMatch(/^already approved by host at \d{4}-/)
  expect(second.approval).toEqual(first)
  expect(handled).toHaveLength(1)
})

test('deciding a missing approval is NOT_FOUND', async () => {
  const { ledger } = recordingLedger(openDb())
  expect(
    await ledger
      .decide({ id: 'apr-missing', decision: 'approve', by: host })
      .catch((caught: unknown) => caught),
  ).toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('an approval requested before a restart is decided after it, running the handler once', async () => {
  const before = openDb()
  const id = requestProcedure(before, recordingLedger(before).ledger)
  for (const sqlite of open.splice(0)) sqlite.close()

  const after = openDb()
  const { ledger, handled } = recordingLedger(after)
  expect(await ledger.start()).toEqual([])
  expect(handled).toEqual([])
  await ledger.decide({ id, decision: 'approve', by: host })

  expect(handled).toEqual([{ id, decision: 'approve' }])
})

test('the approvers are frozen when the approval is requested', async () => {
  const db = openDb()
  grantAdmin(db, 'slack:original', 'ag-a')
  const { ledger } = recordingLedger(db)
  const first = requestProcedure(db, ledger)
  const second = requestProcedure(db, ledger)
  db.run(sql`DELETE FROM user_role WHERE user_id = 'slack:original'`)
  grantAdmin(db, 'slack:newcomer', 'ag-a')

  expect(
    await ledger
      .decide({
        id: first,
        decision: 'approve',
        by: { kind: 'human', userId: 'slack:newcomer' },
      })
      .catch((caught: unknown) => caught),
  ).toMatchObject({ code: 'FORBIDDEN' })
  expect(ledger.show(first).status).toBe('pending')
  expect(
    await ledger.decide({
      id: first,
      decision: 'approve',
      by: { kind: 'human', userId: 'slack:original' },
    }),
  ).toMatchObject({ changed: true, approval: { decidedBy: 'slack:original' } })
  expect(await ledger.decide({ id: second, decision: 'deny', by: host })).toMatchObject({
    changed: true,
    approval: { decidedBy: HOST_OWNER },
  })
})

test('start reruns, exactly once, a decided approval whose handler never finished', async () => {
  const db = openDb()
  const crashing = recordingLedger(db, true)
  const id = requestProcedure(db, crashing.ledger)
  const decided = await crashing.ledger.decide({ id, decision: 'approve', by: host })
  expect(decided.changed).toBe(true)
  expect(decided.message).toContain('handler crashed')
  expect(decided.approval).toMatchObject({ status: 'approved', handledAt: null })

  const { ledger, handled } = recordingLedger(db)
  expect(await ledger.start()).toEqual([])
  expect(await ledger.start()).toEqual([])

  expect(handled).toEqual([{ id, decision: 'approve' }])
  expect(ledger.show(id)).toMatchObject({ handledAt: expect.any(Date) })
})

test('the table refuses a decision without a decider and a handled mark on a pending row', () => {
  const db = openDb()
  const id = requestProcedure(db, recordingLedger(db).ledger)
  expect(() =>
    db.update(pendingApproval).set({ status: 'approved' }).where(eq(pendingApproval.id, id)).run(),
  ).toThrow('CHECK constraint failed')
  expect(() =>
    db
      .update(pendingApproval)
      .set({ handledAt: new Date() })
      .where(eq(pendingApproval.id, id))
      .run(),
  ).toThrow('CHECK constraint failed')
})

function composedHost(db: Db) {
  const accessLedger: AccessLedger = createAccessLedger({ db })
  const approvalLedger = createApprovalLedger({ db, accessLedger, handlers: () => handlers })
  type Context = KurumiContext & { accessLedger: AccessLedger; approvalLedger: ApprovalLedger }
  const router = guardRouter<Context>().router({ access: accessRouter, approval: approvalRouter })
  const contextFor = (caller: Caller, grant: ApprovalGrant | null = null): Context => ({
    db,
    caller,
    guard: approvalLedger.guard,
    grant,
    accessLedger,
    approvalLedger,
  })
  const handlers: ApprovalHandlers = {
    async procedure(approval, decision) {
      if (decision === 'deny') return
      const { path, input, caller } = approval.payload
      await callByPath(router, path, input, contextFor(caller, { approvalId: approval.id }))
    },
    'gateway.request': () => Promise.reject(new Error('no gateway approvals yet')),
  }
  return { router, contextFor }
}

test('an agent-held users.create runs only after the host approves it, and only once', async () => {
  const db = openDb()
  const { router, contextFor } = composedHost(db)

  const held = await new RPCHandler(router).handle(
    new Request('http://agent.invalid/rpc/access/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ json: { id: 'slack:U1', displayName: 'Bob' } }),
    }),
    { prefix: '/rpc', context: contextFor(agent) },
  )
  expect(held.response?.status).toBe(409)
  const body: unknown = await held.response?.json()
  expect(body).toMatchObject({
    json: { code: 'APPROVAL_PENDING', status: 409, data: { approvalId: expect.any(String) } },
  })
  const [approval] = db.select().from(pendingApproval).all()
  if (approval === undefined) throw new Error('the held call left no approval')
  expect(body).toMatchObject({ json: { data: { approvalId: approval.id } } })
  expect(db.select().from(user).all()).toEqual([])

  const hostClient = createRouterClient(router, { context: contextFor(host) })
  const decided = await hostClient.approval.decide([approval.id, { approve: true }])

  expect(decided).toMatchObject({ changed: true, approval: { status: 'approved' } })
  expect(db.select().from(user).all()).toEqual([
    { id: 'slack:U1', kind: 'slack', displayName: 'Bob' },
  ])
  const handledAt = ledgerRow(db, approval.id).handledAt
  expect(handledAt).toBeInstanceOf(Date)

  const again = await hostClient.approval.decide([approval.id, { approve: true }])
  expect(again.changed).toBe(false)
  expect(db.select().from(user).all()).toHaveLength(1)
  expect(ledgerRow(db, approval.id).handledAt).toEqual(handledAt)

  const replayed = createRouterClient(router, {
    context: contextFor(agent, { approvalId: approval.id }),
  })
  expect(
    await replayed.access.users
      .create({ id: 'slack:U2', displayName: 'Eve' })
      .catch((caught: unknown) => caught),
  ).toMatchObject({ code: 'FORBIDDEN' })
})

test('an approve or deny flag is required, but not both', async () => {
  const { router, contextFor } = composedHost(openDb())
  const hostClient = createRouterClient(router, { context: contextFor(host) })
  for (const flags of [{}, { approve: true, deny: true }]) {
    expect(
      await hostClient.approval.decide(['apr-missing', flags]).catch((caught: unknown) => caught),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

function ledgerRow(db: Db, id: string) {
  const row = db.select().from(pendingApproval).where(eq(pendingApproval.id, id)).get()
  if (row === undefined) throw new Error(`approval ${id} is missing`)
  return row
}
