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

function firstMigrations(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-account-migrations-'))
  dirs.push(dir)
  cpSync(accountMigrations.folder, dir, { recursive: true })
  const journalPath = join(dir, 'meta/_journal.json')
  const journal: { entries: unknown[] } = JSON.parse(readFileSync(journalPath, 'utf8'))
  writeFileSync(
    journalPath,
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }),
  )
  return dir
}

test.each(['acc-a', 'acc-o'])(
  'migration removes only the legacy Anthropic credential when %s is the default',
  (defaultId) => {
    const sqlite = new Database(':memory:')
    const db = drizzle(sqlite)
    // SQLite ignores foreign_keys inside drizzle's migration transaction, so the host turns it off around migrate.
    sqlite.run('PRAGMA foreign_keys = OFF')
    migrate(db, {
      migrationsFolder: agentMigrations.folder,
      migrationsTable: agentMigrations.table,
    })
    const table = accountMigrations.table
    migrate(db, { migrationsFolder: firstMigrations(2), migrationsTable: table })
    sqlite.run(
      `INSERT INTO agent_group (id, name, folder, created_at) VALUES ('g1', 'g1', 'g1', 0)`,
    )
    const insert = sqlite.query(
      `INSERT INTO account (id, vendor, label, kind, auth_mode, services, material, status, created_at)
       VALUES (?, ?, ?, 'key', ?, ?, x'00', 'active', 0)`,
    )
    insert.run('acc-a', 'anthropic', 'legacy', 'api-key', '["anthropic-api"]')
    insert.run('acc-o', 'anthropic', 'main', 'oauth-token', '["anthropic-api"]')
    insert.run('acc-g', 'github', 'pat', null, '["github"]')
    const grant = sqlite.query(
      `INSERT INTO account_grant (agent_group_id, account_id, vendor, service, granted_by, granted_at)
       VALUES ('g1', ?, 'anthropic', 'anthropic-api', 'test', 0)`,
    )
    grant.run('acc-a')
    grant.run('acc-o')
    sqlite
      .query(
        `INSERT INTO default_account (agent_group_id, service, account_id, vendor)
       VALUES ('g1', 'anthropic-api', ?, 'anthropic')`,
      )
      .run(defaultId)

    migrate(db, { migrationsFolder: accountMigrations.folder, migrationsTable: table })
    sqlite.run('PRAGMA foreign_keys = ON')

    expect(sqlite.query('SELECT id, vendor, label FROM account ORDER BY id').all()).toEqual([
      { id: 'acc-g', vendor: 'github', label: 'pat' },
      { id: 'acc-o', vendor: 'anthropic', label: 'main' },
    ])
    expect(sqlite.query('SELECT account_id FROM account_grant').all()).toEqual([
      { account_id: 'acc-o' },
    ])
    expect(sqlite.query('SELECT * FROM default_account').all()).toEqual(
      defaultId === 'acc-o'
        ? [
            {
              agent_group_id: 'g1',
              service: 'anthropic-api',
              account_id: 'acc-o',
              vendor: 'anthropic',
            },
          ]
        : [],
    )
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(sqlite.query('PRAGMA table_info(account)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'auth_mode' }),
    )
    sqlite.close()
  },
)
