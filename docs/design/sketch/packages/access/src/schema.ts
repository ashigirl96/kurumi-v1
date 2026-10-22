// @kurumi/access/schema
import { agentGroup } from '@kurumi/agent/schema'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Identity per platform (`slack:U123`, `console:owner`); privilege per User. */
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
  /** null = global */
  agentGroupId: text('agent_group_id').references(() => agentGroup.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').notNull(),
  grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
})

export const agentGroupMember = sqliteTable(
  'agent_group_member',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agentGroupId: text('agent_group_id')
      .notNull()
      .references(() => agentGroup.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agentGroupId] })],
)
