import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrations as agentMigrations } from '@kurumi/agent/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations as accountMigrations } from '../migrations/index.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function firstMigrationOnly(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-account-migrations-'))
  dirs.push(dir)
  cpSync(accountMigrations.folder, dir, { recursive: true })
  const journalPath = join(dir, 'meta/_journal.json')
  const journal: { entries: unknown[] } = JSON.parse(readFileSync(journalPath, 'utf8'))
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }))
  return dir
}

test('accounts written before auth modes existed come through the auth_mode rebuild', () => {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  // SQLite ignores foreign_keys inside drizzle's migration transaction, so the host turns it off around migrate.
  sqlite.run('PRAGMA foreign_keys = OFF')
  migrate(db, { migrationsFolder: agentMigrations.folder, migrationsTable: agentMigrations.table })
  const table = accountMigrations.table
  migrate(db, { migrationsFolder: firstMigrationOnly(), migrationsTable: table })
  sqlite.run(`INSERT INTO agent_group (id, name, folder, created_at) VALUES ('g1', 'g1', 'g1', 0)`)
  const insert = sqlite.query(
    `INSERT INTO account (id, vendor, label, kind, services, material, status, created_at)
     VALUES (?, ?, ?, 'key', ?, x'00', 'active', 0)`,
  )
  insert.run('acc-a', 'anthropic', 'main', '["anthropic-api"]')
  insert.run('acc-g', 'github', 'pat', '["github"]')
  sqlite.run(
    `INSERT INTO account_grant (agent_group_id, account_id, vendor, service, granted_by, granted_at)
     VALUES ('g1', 'acc-a', 'anthropic', 'anthropic-api', 'test', 0)`,
  )

  migrate(db, { migrationsFolder: accountMigrations.folder, migrationsTable: table })

  expect(sqlite.query('SELECT id, auth_mode FROM account ORDER BY id').all()).toEqual([
    { id: 'acc-a', auth_mode: 'api-key' },
    { id: 'acc-g', auth_mode: null },
  ])
  expect(sqlite.query('SELECT account_id FROM account_grant').all()).toEqual([
    { account_id: 'acc-a' },
  ])
  expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
})
