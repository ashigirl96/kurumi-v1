import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountLedger } from '@kurumi/account/server'
import { insertAccount, insertAgentGroup } from '@kurumi/account/testing'

import { migrateAll, openKurumiDb, type KurumiDb } from './db.ts'
import { migrations } from './migrations.ts'

const rebuildAccountGrant = {
  folder: join(import.meta.dir, 'fixtures/rebuild-account-grant'),
  table: '__drizzle_migrations_fixture',
}

let dir: string
let path: string
let db: KurumiDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kurumi-host-db-'))
  path = join(dir, 'kurumi.db')
  db = openKurumiDb(path)
})

afterEach(() => {
  db.$client.close(true)
  rmSync(dir, { recursive: true, force: true })
})

const count = (table: string) =>
  db.$client.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n

function seedTwoGroups() {
  for (const group of ['g1', 'g2']) insertAgentGroup(db, group)
  insertAccount(db, {
    id: 'acc-a',
    vendor: 'google',
    label: 'a',
    services: ['gmail', 'google-calendar'],
  })
  insertAccount(db, {
    id: 'acc-b',
    vendor: 'google',
    label: 'b',
    services: ['gmail', 'google-calendar'],
  })
  insertAccount(db, { id: 'acc-c', vendor: 'google', label: 'c', services: ['gmail'] })
  const ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
  db.transaction((tx) => {
    const grant = (agentGroupId: string, accountId: string, service: 'gmail' | 'google-calendar') =>
      ledger.grant(tx, { agentGroupId, accountId, service, grantedBy: 'test' })
    for (const account of ['acc-a', 'acc-b', 'acc-c']) grant('g1', account, 'gmail')
    grant('g2', 'acc-b', 'gmail')
    grant('g2', 'acc-a', 'google-calendar')
    ledger.setDefault(tx, { agentGroupId: 'g1', accountId: 'acc-a', service: 'gmail' })
    ledger.setDefault(tx, { agentGroupId: 'g2', accountId: 'acc-b', service: 'gmail' })
  })
}

describe('migrateAll', () => {
  test('a migration that rebuilds account_grant keeps every grant and default', () => {
    migrateAll(db, migrations)
    seedTwoGroups()

    migrateAll(db, [...migrations, rebuildAccountGrant])

    expect(count('account_grant')).toBe(5)
    expect(count('default_account')).toBe(2)
  })

  test('the rebuilt table still takes the new service and still cascades', () => {
    migrateAll(db, migrations)
    seedTwoGroups()
    migrateAll(db, [...migrations, rebuildAccountGrant])

    insertAccount(db, { id: 'acc-d', vendor: 'google', label: 'd', services: ['gmail'] })
    db.$client.run(
      `INSERT INTO account_grant VALUES ('g1', 'acc-d', 'google', 'google-drive', 'test', 0)`,
    )
    db.$client.run(`DELETE FROM account_grant WHERE account_id = 'acc-a' AND service = 'gmail'`)

    expect(count('account_grant')).toBe(5)
    expect(count('default_account')).toBe(1)
  })

  test('a row left without a parent stops the migration and names its table', () => {
    migrateAll(db, migrations)
    db.$client.run('PRAGMA foreign_keys = OFF')
    db.$client.run(
      `INSERT INTO account_grant VALUES ('no-group', 'no-account', 'google', 'gmail', 'test', 0)`,
    )

    expect(() => migrateAll(db, migrations)).toThrow(/account_grant/)
  })

  test('a database that already has an orphan is not migrated any further', () => {
    migrateAll(db, migrations)
    db.$client.run('PRAGMA foreign_keys = OFF')
    db.$client.run(
      `INSERT INTO account_grant VALUES ('no-group', 'no-account', 'google', 'gmail', 'test', 0)`,
    )

    expect(() => migrateAll(db, [...migrations, rebuildAccountGrant])).toThrow(/account_grant/)

    const applied = db.$client
      .query(`SELECT name FROM sqlite_master WHERE name = '${rebuildAccountGrant.table}'`)
      .all()
    expect(applied).toEqual([])
  })

  test('foreign keys are on again afterwards, whether or not it threw', () => {
    migrateAll(db, migrations)
    const foreignKeys = () =>
      db.$client.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys

    expect(foreignKeys()).toBe(1)

    db.$client.run('PRAGMA foreign_keys = OFF')
    db.$client.run(
      `INSERT INTO account_grant VALUES ('no-group', 'no-account', 'google', 'gmail', 'test', 0)`,
    )
    expect(() => migrateAll(db, migrations)).toThrow()
    expect(foreignKeys()).toBe(1)
  })

  test('inside a transaction it refuses, because the pragma would be ignored there', () => {
    expect(() => db.transaction(() => migrateAll(db, migrations))).toThrow(/outside a transaction/)
  })
})

describe('openKurumiDb', () => {
  test('a second process cannot open the file while the first holds it, and says so at once', async () => {
    migrateAll(db, migrations)
    const script = `
      import { openKurumiDb } from ${JSON.stringify(join(import.meta.dir, 'db.ts'))}
      const started = performance.now()
      try {
        openKurumiDb(${JSON.stringify(path)})
        console.log(JSON.stringify({ failed: false }))
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, ms: performance.now() - started }))
      }
    `
    const child = Bun.spawn([process.execPath, '-e', script], { env: process.env, stdout: 'pipe' })

    const result = (await new Response(child.stdout).json()) as { code?: string; ms?: number }

    expect(result.code).toBe('SQLITE_BUSY')
    expect(result.ms).toBeLessThan(1000)
  })
})
