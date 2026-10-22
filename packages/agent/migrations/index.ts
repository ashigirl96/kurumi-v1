import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'agent'),
  table: '__drizzle_migrations_agent',
}
