import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'chat'),
  table: '__drizzle_migrations_chat',
}
