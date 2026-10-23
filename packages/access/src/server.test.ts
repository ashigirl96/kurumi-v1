import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import { migrations as agentMigrations } from '@kurumi/agent/server'
import type { Db } from '@kurumi/rpc/server'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { user, userRole } from './schema.ts'
import { createAccessLedger, migrations, type AccessLedger } from './server.ts'

let sqlite: Database
let db: Db
let ledger: AccessLedger

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  db = drizzle(sqlite)
  for (const { folder, table } of [agentMigrations, migrations]) {
    migrate(db, { migrationsFolder: folder, migrationsTable: table })
  }
  for (const id of ['ag-a', 'ag-b']) {
    db.run(
      sql`INSERT INTO agent_group (id, name, folder, created_at) VALUES (${id}, ${id}, ${id}, 0)`,
    )
  }
  ledger = createAccessLedger({ db })
})

afterEach(() => {
  sqlite.close()
})

const userApprover = (userId: string) => ({ kind: 'user', userId }) as const

function grant(userId: string, role: 'owner' | 'admin', agentGroupId: string | null, at: number) {
  db.insert(user)
    .values({ id: userId, kind: 'slack', displayName: userId })
    .onConflictDoNothing()
    .run()
  db.insert(userRole)
    .values({ userId, role, agentGroupId, grantedBy: 'host', grantedAt: new Date(at) })
    .run()
}

test('the approver chain lists scoped admins, global admins, owners, then the host, once each', () => {
  grant('slack:owner', 'owner', null, 1)
  grant('slack:global', 'admin', null, 2)
  grant('slack:scoped', 'admin', 'ag-a', 3)
  grant('slack:elsewhere', 'admin', 'ag-b', 4)
  grant('slack:owner', 'admin', 'ag-a', 5)

  expect(ledger.approverChain('ag-a')).toEqual([
    userApprover('slack:scoped'),
    userApprover('slack:owner'),
    userApprover('slack:global'),
    { kind: 'host' },
  ])
  expect(ledger.approverChain(null)).toEqual([
    userApprover('slack:global'),
    userApprover('slack:owner'),
    { kind: 'host' },
  ])
})

test('the host and global owners are owners; scoped owners, admins, and agents are not', () => {
  grant('slack:owner', 'owner', null, 1)
  grant('slack:scoped-owner', 'owner', 'ag-a', 2)
  grant('slack:admin', 'admin', null, 3)

  expect(ledger.isOwner({ kind: 'host' })).toBe(true)
  expect(ledger.isOwner({ kind: 'human', userId: 'slack:owner' })).toBe(true)
  expect(ledger.isOwner({ kind: 'human', userId: 'slack:scoped-owner' })).toBe(false)
  expect(ledger.isOwner({ kind: 'human', userId: 'slack:admin' })).toBe(false)
  expect(ledger.isOwner({ kind: 'agent', agentGroupId: 'ag-a', sessionId: 's' })).toBe(false)
})

test('an approver is a caller whose principal is in the given set, and no user id names the host', () => {
  const approvers = [{ kind: 'user', userId: 'slack:admin' }, { kind: 'host' }] as const
  expect(ledger.isApprover({ kind: 'host' }, approvers)).toBe(true)
  expect(ledger.isApprover({ kind: 'human', userId: 'slack:admin' }, approvers)).toBe(true)
  expect(ledger.isApprover({ kind: 'human', userId: 'slack:other' }, approvers)).toBe(false)
  expect(ledger.isApprover({ kind: 'human', userId: 'host' }, approvers)).toBe(false)
  expect(ledger.isApprover({ kind: 'host' }, [{ kind: 'user', userId: 'host' }])).toBe(false)
  expect(
    ledger.isApprover({ kind: 'agent', agentGroupId: 'ag-a', sessionId: 's' }, approvers),
  ).toBe(false)
})

test('creating a user takes the kind from the id and is idempotent on the id', () => {
  expect(ledger.createUser({ id: 'slack:U1', displayName: 'Bob' })).toEqual({
    id: 'slack:U1',
    kind: 'slack',
    displayName: 'Bob',
  })
  expect(ledger.createUser({ id: 'slack:U1', displayName: 'Robert' }).displayName).toBe('Bob')
  expect(db.select().from(user).all()).toHaveLength(1)
  expect(() => ledger.createUser({ id: 'U1', displayName: 'Bob' })).toThrow('<kind>:<handle>')
  for (const hidden of ['\u202e', '\u200b', '\u3164', '\ufe0f', '\u0085']) {
    expect(() => ledger.createUser({ id: `slack:U1${hidden}x`, displayName: 'Bob' })).toThrow(
      'invisible',
    )
  }
  expect(db.select().from(user).all()).toHaveLength(1)
})
