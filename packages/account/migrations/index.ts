import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'account'),
  table: '__drizzle_migrations_account',
}
