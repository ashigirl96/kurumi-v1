// drizzle-kit generate writes ./agent/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./agent', import.meta.url).pathname, table: '__drizzle_migrations_agent', latest: 0 }
