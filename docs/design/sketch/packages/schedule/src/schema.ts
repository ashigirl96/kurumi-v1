// @kurumi/schedule/schema
import { agentGroup } from '@kurumi/agent/schema'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const taskSeries = sqliteTable('task_series', {
  id: text('id').primaryKey(),
  agentGroupId: text('agent_group_id')
    .notNull()
    .references(() => agentGroup.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  /** 5-field cron, null = one-shot */
  recurrence: text('recurrence'),
  timezone: text('timezone').notNull(),
  script: text('script'),
  status: text('status', { enum: ['active', 'paused', 'done'] }).notNull(),
  nextAt: integer('next_at', { mode: 'timestamp_ms' }),
  failures: integer('failures').notNull().default(0),
  createdBy: text('created_by').notNull(),
})
