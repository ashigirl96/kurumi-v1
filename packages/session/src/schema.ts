import { agentGroup } from '@kurumi/agent/schema'
import { messagingGroup } from '@kurumi/chat/schema'
import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    agentGroupId: text('agent_group_id')
      .notNull()
      .references(() => agentGroup.id, { onDelete: 'cascade' }),
    messagingGroupId: text('messaging_group_id').references(() => messagingGroup.id, {
      onDelete: 'set null',
    }),
    threadId: text('thread_id'),
    mode: text('mode', { enum: ['shared', 'per-thread', 'agent-shared', 'task'] }).notNull(),
    status: text('status', { enum: ['active', 'closed'] }).notNull(),
    lastActiveAt: integer('last_active_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('session_key').on(
      t.agentGroupId,
      sql`coalesce(${t.messagingGroupId}, '')`,
      sql`coalesce(${t.threadId}, '')`,
      t.mode,
    ),
  ],
)

export const inboundMessage = sqliteTable(
  'inbound_message',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['chat', 'task', 'system', 'echo', 'answer'] }).notNull(),
    trigger: integer('trigger', { mode: 'boolean' }).notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    claimedBy: text('claimed_by'),
    processAfter: integer('process_after', { mode: 'timestamp_ms' }),
    tries: integer('tries').notNull().default(0),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('inbound_seq').on(t.sessionId, t.seq),
    index('inbound_due').on(t.status, t.processAfter),
  ],
)

export const outboundMessage = sqliteTable(
  'outbound_message',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    inReplyTo: text('in_reply_to'),
    to: text('to'),
    kind: text('kind', {
      enum: ['text', 'file', 'card', 'question', 'reaction', 'edit', 'task_log'],
    }).notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['queued', 'delivered', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    platformMessageId: text('platform_message_id'),
    deliverAfter: integer('deliver_after', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('outbound_seq').on(t.sessionId, t.seq),
    index('outbound_queued').on(t.status),
  ],
)

export const sessionState = sqliteTable(
  'session_state',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.key] })],
)

export const container = sqliteTable(
  'container',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    tokenHash: blob('token_hash', { mode: 'buffer' }).notNull().unique(),
    status: text('status', { enum: ['starting', 'running', 'stopping'] }).notNull(),
    image: text('image').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    currentTool: text('current_tool'),
    toolDeadlineAt: integer('tool_deadline_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('container_one_per_session')
      .on(t.sessionId)
      .where(sql`status in ('starting','running')`),
  ],
)
