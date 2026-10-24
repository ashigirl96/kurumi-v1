import { join } from 'node:path'

export const migrations = {
  folder: join(import.meta.dir, 'gateway'),
  table: '__drizzle_migrations_gateway',
}
