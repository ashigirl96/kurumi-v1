// drizzle-kit generate writes ./account/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./account', import.meta.url).pathname, table: '__drizzle_migrations_account', latest: 0 }
