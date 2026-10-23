import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'approval'),
  table: '__drizzle_migrations_approval',
}
