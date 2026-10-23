import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { approvalKinds, approvalStatuses } from './contract.ts'

export const pendingApproval = sqliteTable(
  'pending_approval',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: approvalKinds }).notNull(),
    agentGroupId: text('agent_group_id'),
    sessionId: text('session_id'),
    title: text('title').notNull(),
    body: text('body', { mode: 'json' }).$type<string[]>().notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    /** Resolved once at request time; a later role change does not change who may decide. */
    approvers: text('approvers', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status', { enum: approvalStatuses }).notNull(),
    decidedBy: text('decided_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    check(
      'pending_approval_decided_iff_not_pending',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    check(
      'pending_approval_handled_only_when_decided',
      sql`${t.handledAt} IS NULL OR ${t.status} <> 'pending'`,
    ),
  ],
)
