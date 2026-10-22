// drizzle-kit generate writes ./slack/ next to this file; the history table is per package (monica ADR-0010).
export const migrations = { folder: new URL('./slack', import.meta.url).pathname, table: '__drizzle_migrations_slack', latest: 0 }
