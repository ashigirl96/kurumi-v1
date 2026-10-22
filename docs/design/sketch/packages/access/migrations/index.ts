// drizzle-kit generate writes ./access/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./access', import.meta.url).pathname, table: '__drizzle_migrations_access', latest: 0 }
