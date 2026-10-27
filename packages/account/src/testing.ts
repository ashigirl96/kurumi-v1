import { Database } from 'bun:sqlite'

import { migrations as agentMigrations } from '@kurumi/agent/server'
import type { Db } from '@kurumi/rpc/server'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations as accountMigrations } from '../migrations/index.ts'
import { type ServiceId, type VendorId } from './catalog.ts'
import { account } from './schema.ts'

export function inMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const { folder, table } of [agentMigrations, accountMigrations]) {
    migrate(db, { migrationsFolder: folder, migrationsTable: table })
  }
  return db
}

type TestDb = Pick<Db, 'run' | 'insert'>

export function insertAgentGroup(db: TestDb, id: string) {
  db.run(
    sql`INSERT INTO agent_group (id, name, folder, created_at) VALUES (${id}, ${id}, ${id}, 0)`,
  )
}

export function insertAccount(
  db: TestDb,
  row: {
    id: string
    vendor: VendorId
    label: string
    services: ServiceId[]
    status?: 'active' | 'needs_reauth'
  },
) {
  db.insert(account)
    .values({
      kind: 'oauth',
      material: Buffer.alloc(0),
      status: 'active',
      createdAt: new Date(0),
      ...row,
    })
    .run()
}
