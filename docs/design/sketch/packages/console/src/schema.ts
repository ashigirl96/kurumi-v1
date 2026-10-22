// @kurumi/console/schema — was data/console.db; now tables in kurumi.db under this package's migrations.
import { agentGroup } from '@kurumi/agent/schema'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const consoleMessage = sqliteTable('console_message', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(), // agent group id or group chat id
  author: text('author').notNull(),
  body: text('body', { mode: 'json' }).notNull(), // text | Card | file ref
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const readPosition = sqliteTable('read_position', {
  chatId: text('chat_id').primaryKey(),
  messageId: text('message_id').notNull(),
})

export const groupChat = sqliteTable('group_chat', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  members: text('members', { mode: 'json' }).$type<string[]>().notNull(),
})

export const appearance = sqliteTable('appearance', {
  agentGroupId: text('agent_group_id')
    .primaryKey()
    .references(() => agentGroup.id, { onDelete: 'cascade' }),
  label: text('label'),
  avatar: text('avatar'),
})
