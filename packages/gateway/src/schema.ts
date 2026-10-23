import { sql } from 'drizzle-orm'
import { blob, check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const gatewayCa = sqliteTable(
  'gateway_ca',
  {
    id: integer('id').primaryKey(),
    certPem: text('cert_pem').notNull(),
    sealedKey: blob('sealed_key', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [check('gateway_ca_single_row', sql`${t.id} = 1`)],
)
