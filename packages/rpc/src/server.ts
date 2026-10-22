import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

export type Db = BunSQLiteDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
