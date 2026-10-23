import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'access'),
  table: '__drizzle_migrations_access',
}
