// drizzle-kit generate writes ./gateway/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./gateway', import.meta.url).pathname, table: '__drizzle_migrations_gateway', latest: 0 }
