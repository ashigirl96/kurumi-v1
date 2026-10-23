import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'session'),
  table: '__drizzle_migrations_session',
}
