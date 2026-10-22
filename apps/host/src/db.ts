import { Database } from 'bun:sqlite'

import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

export type KurumiDb = BunSQLiteDatabase & { $client: Database }

export type MigrationSource = { folder: string; table: string }

/**
 * The host is the only process that opens kurumi.db. EXCLUSIVE comes before WAL so the WAL index lives on the
 * heap, and a second host fails at its first query with SQLITE_BUSY. There is no busy_timeout, so it fails at
 * once instead of waiting.
 */
export function openKurumiDb(path: string): KurumiDb {
  const sqlite = new Database(path)
  sqlite.run('PRAGMA locking_mode = EXCLUSIVE')
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA foreign_keys = ON')
  return drizzle(sqlite)
}

/**
 * Applies each package's migrations in order with foreign keys off. SQLite ignores that pragma inside a
 * transaction and drizzle runs every migration in one, so a generated table rebuild would delete the rows that
 * cascade from the dropped table. Setting it here, outside, keeps those rows; the check afterwards then names any
 * row left without a parent.
 */
export function migrateAll(db: KurumiDb, migrations: readonly MigrationSource[]): void {
  const sqlite = db.$client
  if (sqlite.inTransaction) throw new Error('migrateAll must run outside a transaction')

  sqlite.run('PRAGMA foreign_keys = OFF')
  try {
    for (const { folder, table } of migrations) {
      migrate(db, { migrationsFolder: folder, migrationsTable: table })
    }
    const violations = sqlite
      .query<{ table: string; rowid: number | null; parent: string }, []>(
        'PRAGMA foreign_key_check',
      )
      .all()
    if (violations.length > 0) {
      const tables = [...new Set(violations.map(({ table }) => table))].join(', ')
      throw new Error(`foreign key violations after migrating, in: ${tables}`)
    }
  } finally {
    sqlite.run('PRAGMA foreign_keys = ON')
  }
}
