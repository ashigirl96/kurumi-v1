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
    approvers: text('approvers', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status', { enum: approvalStatuses }).notNull(),
    decidedBy: text('decided_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
    handlerError: text('handler_error'),
  },
  (t) => [
    check('pending_approval_kind', sql`${t.kind} IN ${oneOf(approvalKinds)}`),
    check('pending_approval_status', sql`${t.status} IN ${oneOf(approvalStatuses)}`),
    check(
      'pending_approval_decided_by_iff_decided',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL)`,
    ),
    check(
      'pending_approval_decided_at_iff_decided',
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    check(
      'pending_approval_handled_only_when_decided',
      sql`${t.handledAt} IS NULL OR ${t.status} <> 'pending'`,
    ),
    check(
      'pending_approval_handler_error_only_when_handled',
      sql`${t.handlerError} IS NULL OR ${t.handledAt} IS NOT NULL`,
    ),
  ],
)

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`)
}
