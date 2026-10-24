import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { egressDecisions, ruleEffects } from './contract.ts'

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

export const egressRule = sqliteTable(
  'egress_rule',
  {
    id: text('id').primaryKey(),
    priority: integer('priority').notNull(),
    effect: text('effect', { enum: ruleEffects }).notNull(),
    accountHandle: text('account_handle'),
    service: text('service'),
    host: text('host'),
    method: text('method'),
    path: text('path'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('egress_rule_account_handle').on(t.accountHandle),
    index('egress_rule_service').on(t.service),
    check('egress_rule_one_target', sql`(${t.accountHandle} is null) <> (${t.service} is null)`),
    check('egress_rule_effect', sql`${t.effect} in ${oneOf(ruleEffects)}`),
    check('egress_rule_exact_host', sql`${t.host} is null or instr(${t.host}, '*') = 0`),
    check('egress_rule_rooted_path', sql`${t.path} is null or substr(${t.path}, 1, 1) = '/'`),
  ],
)

export const allowanceStates = ['pending', 'granted', 'used', 'denied'] as const

export const egressAllowance = sqliteTable(
  'egress_allowance',
  {
    approvalId: text('approval_id').primaryKey(),
    agentGroupId: text('agent_group_id').notNull(),
    sessionId: text('session_id').notNull(),
    ruleId: text('rule_id').notNull(),
    accountHandle: text('account_handle').notNull(),
    method: text('method').notNull(),
    host: text('host').notNull(),
    /** Without the query, as the notice names it. */
    path: text('path').notNull(),
    fingerprint: blob('fingerprint', { mode: 'buffer' }).notNull(),
    state: text('state', { enum: allowanceStates }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('egress_allowance_session_fingerprint').on(t.sessionId, t.fingerprint),
    index('egress_allowance_agent_group_state').on(t.agentGroupId, t.state),
    check('egress_allowance_state', sql`${t.state} in ${oneOf(allowanceStates)}`),
    check(
      'egress_allowance_expires_iff_granted',
      sql`(${t.state} in ('granted', 'used')) = (${t.expiresAt} is not null)`,
    ),
    check(
      'egress_allowance_used_at_iff_used',
      sql`(${t.state} = 'used') = (${t.usedAt} is not null)`,
    ),
  ],
)

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`)
}
