// drizzle-kit generate writes ./session/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./session', import.meta.url).pathname, table: '__drizzle_migrations_session', latest: 0 }
