// @kurumi/approval/schema
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Closed list, so the host's `ApprovalHandlers` record must name a handler for every kind (compile error otherwise).
 * 'procedure' = a held oRPC call, replayed through the guarded router with the approval as grant.
 */
export type ApprovalKind = 'procedure' | 'sender.admission' | 'chat.registration' | 'a2a.message' | 'gateway.request'

/** Where the request came from. Shown on every card; used as the card's place only if the policy says so. */
export type ApprovalOrigin = {
  agentGroupId: string | null
  sessionId: string | null
  messagingGroupId: string | null
  threadId: string | null
  /** Human-readable "which chat asked", rendered at creation. */
  chatName: string | null
}

/**
 * Every human decision in flight: guarded procedures, Sender Admission, Chat Registration, agent-to-agent holds,
 * Credential Approvals. Durable: a host restart keeps the card answerable.
 */
export const pendingApproval = sqliteTable('pending_approval', {
  id: text('id').primaryKey(), // apr-<uuidv7>; also the card's action id
  kind: text('kind').$type<ApprovalKind>().notNull(),
  origin: text('origin', { mode: 'json' }).$type<ApprovalOrigin>().notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  title: text('title').notNull(),
  /** Card body as the approver saw it; never regenerated. */
  body: text('body', { mode: 'json' }).$type<string[]>().notNull(),
  /**
   * Who may decide, resolved once at creation (group admins → global admins → owners) and baked in: a later role
   * change does not change who may click this card.
   */
  approvers: text('approvers', { mode: 'json' }).$type<string[]>().notNull(),
  /** Where the card was delivered (CardRef), to edit it on resolution. Set after delivery. */
  cardRef: text('card_ref', { mode: 'json' }),
  status: text('status', { enum: ['pending', 'awaiting_reason', 'approved', 'rejected', 'expired'] }).notNull(),
  decidedBy: text('decided_by'),
  reason: text('reason'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  /** Set when the kind's handler finished. decided ∧ handledAt null at boot → handler re-runs (idempotent). */
  handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
})
