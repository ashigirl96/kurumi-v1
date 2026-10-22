// drizzle-kit generate writes ./approval/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./approval', import.meta.url).pathname, table: '__drizzle_migrations_approval', latest: 0 }
