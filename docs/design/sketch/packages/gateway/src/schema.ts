// @kurumi/gateway/schema
import { account } from '@kurumi/account/schema'
import type { ServiceId } from '@kurumi/account/contract'
import { agentGroup } from '@kurumi/agent/schema'
import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Egress Rule: first match by (priority, id). Targets an account (not just a service), so
 * "approve Gmail sends from google/alice@work only" does not leak onto google/bob@home.
 * agentGroupId null = every group.
 */
export const egressRule = sqliteTable(
  'egress_rule',
  {
    id: text('id').primaryKey(),
    priority: integer('priority').notNull(),
    agentGroupId: text('agent_group_id').references(() => agentGroup.id, { onDelete: 'cascade' }),
    /** Exactly one of accountId / service / hostPattern is set — the CHECK below; the contract mirrors it as a union. */
    accountId: text('account_id').references(() => account.id, { onDelete: 'cascade' }),
    service: text('service').$type<ServiceId>(),
    hostPattern: text('host_pattern'),
    method: text('method'), // null = any
    pathPattern: text('path_pattern'), // glob; null = any
    effect: text('effect', { enum: ['allow', 'block', 'approve', 'rate_limit'] }).notNull(),
    ratePerMinute: integer('rate_per_minute'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    check(
      'egress_rule_one_target',
      sql`(${t.accountId} is not null) + (${t.service} is not null) + (${t.hostPattern} is not null) = 1`,
    ),
    check('egress_rule_rate', sql`(${t.effect} = 'rate_limit') = (${t.ratePerMinute} is not null)`),
  ],
)

/**
 * One-shot permission minted when a human approves a request whose hold already ended (timeout, agent
 * disconnect, host restart). The agent is told to resend the IDENTICAL request; that retry passes once.
 * The fingerprint keeps the full body hash on purpose: the approval binds to what the human saw. A retry whose
 * body differs (an LLM regenerating the mail text) is a new request and is held again — risk, tested in unit 5.
 */
export const egressAllowance = sqliteTable(
  'egress_allowance',
  {
    approvalId: text('approval_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** sha256(method, host, path, accountId, full body) */
    fingerprint: blob('fingerprint', { mode: 'buffer' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('allowance_lookup').on(t.sessionId, t.fingerprint)],
)

/** Request log: injected or not-plainly-allowed requests only. Batched insert (1 s), pruned at 30 days. */
export const egressLog = sqliteTable(
  'egress_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    agentGroupId: text('agent_group_id').notNull(),
    sessionId: text('session_id').notNull(),
    /** Which account was injected — the fact OneCLI v1.42.0 did not record. */
    accountId: text('account_id'),
    method: text('method').notNull(),
    host: text('host').notNull(),
    path: text('path').notNull(),
    decision: text('decision', {
      enum: ['injected', 'blocked', 'approved', 'denied', 'timed_out', 'rate_limited', 'refused'],
    }).notNull(),
    refusal: text('refusal'), // SelectionRefusal code
    status: integer('status'),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('egress_log_at').on(t.at)],
)

/** The MITM CA. Key vault-encrypted, so it backs up and restores with kurumi.db + vault.key. */
export const gatewayCa = sqliteTable('gateway_ca', {
  id: integer('id').primaryKey(), // always 1
  certPem: text('cert_pem').notNull(),
  keyPem: blob('key_pem', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
