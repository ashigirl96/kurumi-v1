// @kurumi/agent/schema
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const agentGroup = sqliteTable('agent_group', {
  id: text('id').primaryKey(), // ag-<uuidv7>
  name: text('name').notNull(),
  folder: text('folder').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const containerConfig = sqliteTable('container_config', {
  agentGroupId: text('agent_group_id')
    .primaryKey()
    .references(() => agentGroup.id, { onDelete: 'cascade' }),
  model: text('model'),
  effort: text('effort'),
  fast: integer('fast', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  packages: text('packages', { mode: 'json' }).$type<{ apt: string[]; npm: string[] }>().notNull(),
  mcpServers: text('mcp_servers', { mode: 'json' }).$type<{ name: string; command: string; args: string[] }[]>().notNull(),
  skills: text('skills', { mode: 'json' }).$type<string[] | 'all'>().notNull(),
  extraMounts: text('extra_mounts', { mode: 'json' }).$type<{ hostPath: string; containerPath: string; readonly: boolean }[]>().notNull(),
  cliScope: text('cli_scope', { enum: ['disabled', 'group', 'global'] }).notNull(),
  timezone: text('timezone'),
})
