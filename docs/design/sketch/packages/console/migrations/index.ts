// drizzle-kit generate writes ./console/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./console', import.meta.url).pathname, table: '__drizzle_migrations_console', latest: 0 }
