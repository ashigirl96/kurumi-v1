// drizzle-kit generate writes ./chat/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./chat', import.meta.url).pathname, table: '__drizzle_migrations_chat', latest: 0 }
