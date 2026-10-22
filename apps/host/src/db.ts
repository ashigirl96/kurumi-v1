import { Database } from 'bun:sqlite'

import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

export type KurumiDb = BunSQLiteDatabase & { $client: Database }

export type MigrationSource = { folder: string; table: string }

/**
 * EXCLUSIVE must precede WAL so SQLite keeps the WAL index on the heap and a second process gets SQLITE_BUSY
 * while opening. There is no busy_timeout because a second host has to fail at once, not wait.
 */
export function openKurumiDb(path: string): KurumiDb {
  const sqlite = new Database(path)
  sqlite.run('PRAGMA locking_mode = EXCLUSIVE')
  const journal = sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get()
  if (journal?.journal_mode !== 'wal') {
    sqlite.close()
    throw new Error(`kurumi.db could not enter WAL mode (journal_mode is ${journal?.journal_mode})`)
  }
  sqlite.run('PRAGMA foreign_keys = ON')
  return drizzle(sqlite)
}

type Violation = { table: string; rowid: number | null; parent: string }

function assertNoViolations(sqlite: Database, moment: string) {
  const violations = sqlite.query<Violation, []>('PRAGMA foreign_key_check').all()
  if (violations.length === 0) return
  const shown = violations
    .slice(0, 5)
    .map(({ table, rowid, parent }) => `${table} row ${rowid} has no parent in ${parent}`)
  const more =
    violations.length > shown.length ? `, and ${violations.length - shown.length} more` : ''
  throw new Error(`foreign key violations ${moment}: ${shown.join('; ')}${more}`)
}

/**
 * SQLite ignores foreign_keys inside the transaction drizzle wraps each package's migrations in, so a generated
 * table rebuild would cascade-delete rows unless the pragma is turned off here. drizzle issues its own BEGIN,
 * so the packages commit one by one. The check before the first one keeps a database that is already broken from
 * being migrated further.
 */
export function migrateAll(db: KurumiDb, migrations: readonly MigrationSource[]): void {
  const sqlite = db.$client
  if (sqlite.inTransaction) throw new Error('migrateAll must run outside a transaction')

  sqlite.run('PRAGMA foreign_keys = OFF')
  try {
    assertNoViolations(sqlite, 'before migrating')
    for (const { folder, table } of migrations) {
      migrate(db, { migrationsFolder: folder, migrationsTable: table })
    }
    assertNoViolations(sqlite, 'after migrating')
  } finally {
    sqlite.run('PRAGMA foreign_keys = ON')
  }
}
