import { agentGroup } from '@kurumi/agent/schema'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
})

export const userRole = sqliteTable('user_role', {
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin'] }).notNull(),
  agentGroupId: text('agent_group_id').references(() => agentGroup.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').notNull(),
  grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
})
