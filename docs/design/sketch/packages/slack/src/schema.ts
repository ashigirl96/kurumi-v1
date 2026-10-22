// @kurumi/slack/schema
import { blob, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const slackInstance = sqliteTable('slack_instance', {
  name: text('name').primaryKey(),
  botToken: blob('bot_token', { mode: 'buffer' }).notNull(), // vault-encrypted
  appToken: blob('app_token', { mode: 'buffer' }), // vault-encrypted, Socket Mode only
  mode: text('mode', { enum: ['socket', 'webhook'] }).notNull(),
})

export const slackRoom = sqliteTable('slack_room', {
  channelId: text('channel_id').primaryKey(),
  instance: text('instance').notNull(),
  canvasId: text('canvas_id'),
})
