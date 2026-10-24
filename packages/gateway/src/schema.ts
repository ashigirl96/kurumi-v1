import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { egressDecisions } from './contract.ts'

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

export const egressLog = sqliteTable(
  'egress_log',
  {
    id: integer('id').primaryKey(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    agentGroupId: text('agent_group_id').notNull(),
    sessionId: text('session_id').notNull(),
    host: text('host').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    account: text('account'),
    service: text('service'),
    decision: text('decision', { enum: egressDecisions }).notNull(),
    refusal: text('refusal'),
    status: integer('status'),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [
    index('egress_log_at').on(t.at),
    check('egress_log_refusal', sql`(${t.decision} = 'refused') = (${t.refusal} is not null)`),
    check('egress_log_account', sql`(${t.decision} = 'injected') = (${t.account} is not null)`),
  ],
)
