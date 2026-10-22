// drizzle-kit generate writes ./schedule/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./schedule', import.meta.url).pathname, table: '__drizzle_migrations_schedule', latest: 0 }
