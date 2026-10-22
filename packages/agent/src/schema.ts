import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const agentGroup = sqliteTable('agent_group', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  folder: text('folder').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
