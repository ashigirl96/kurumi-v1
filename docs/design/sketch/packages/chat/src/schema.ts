// @kurumi/chat/schema (surface only)
import { agentGroup } from '@kurumi/agent/schema'
import { user } from '@kurumi/access/schema'
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const messagingGroup = sqliteTable(
  'messaging_group',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    instance: text('instance'),
    platformId: text('platform_id').notNull(),
    name: text('name').notNull(),
    isGroup: integer('is_group', { mode: 'boolean' }).notNull(),
    unknownSenderPolicy: text('unknown_sender_policy', { enum: ['strict', 'request_approval', 'decline_notify', 'public'] }).notNull(),
    deniedAt: integer('denied_at', { mode: 'timestamp_ms' }),
    detachedAt: integer('detached_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('messaging_group_key').on(t.channel, t.instance, t.platformId)],
)

export const wiring = sqliteTable('wiring', {
  id: text('id').primaryKey(),
  messagingGroupId: text('messaging_group_id').notNull().references(() => messagingGroup.id, { onDelete: 'cascade' }),
  agentGroupId: text('agent_group_id').notNull().references(() => agentGroup.id, { onDelete: 'cascade' }),
  engageMode: text('engage_mode', { enum: ['mention', 'mention-sticky', 'pattern'] }).notNull(),
  engagePattern: text('engage_pattern'),
  sessionMode: text('session_mode', { enum: ['shared', 'per-thread', 'agent-shared'] }).notNull(),
  senderScope: text('sender_scope', { enum: ['all', 'known'] }).notNull(),
  accumulate: integer('accumulate', { mode: 'boolean' }).notNull(),
  threads: integer('threads', { mode: 'boolean' }),
  priority: integer('priority').notNull(),
})

export const destination = sqliteTable('destination', {
  agentGroupId: text('agent_group_id').notNull().references(() => agentGroup.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  targetMessagingGroupId: text('target_messaging_group_id'),
  targetAgentGroupId: text('target_agent_group_id'),
})

export const userDm = sqliteTable('user_dm', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  messagingGroupId: text('messaging_group_id').notNull().references(() => messagingGroup.id, { onDelete: 'cascade' }),
})
