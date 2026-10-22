import { agentGroup } from '@kurumi/agent/schema'
import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import { serviceBelongsToVendorSql, type ServiceId, type VendorId } from './catalog.ts'

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    vendor: text('vendor').$type<VendorId>().notNull(),
    label: text('label').notNull(),
    subject: text('subject'),
    kind: text('kind', { enum: ['oauth', 'key'] }).notNull(),
    services: text('services', { mode: 'json' }).$type<ServiceId[]>().notNull(),
    material: blob('material', { mode: 'buffer' }).notNull(),
    accessExpiresAt: integer('access_expires_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['active', 'needs_reauth'] }).notNull(),
    autoGrant: integer('auto_grant', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('account_vendor_label').on(t.vendor, t.label),
    uniqueIndex('account_vendor_subject').on(t.vendor, t.subject),
    // SQLite requires a unique index on the parent columns of a composite foreign key.
    uniqueIndex('account_id_vendor').on(t.id, t.vendor),
  ],
)

export const accountGrant = sqliteTable(
  'account_grant',
  {
    agentGroupId: text('agent_group_id')
      .notNull()
      .references(() => agentGroup.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    vendor: text('vendor').$type<VendorId>().notNull(),
    service: text('service').$type<ServiceId>().notNull(),
    grantedBy: text('granted_by').notNull(),
    grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentGroupId, t.accountId, t.service] }),
    foreignKey({
      columns: [t.accountId, t.vendor],
      foreignColumns: [account.id, account.vendor],
    }).onDelete('cascade'),
    check(
      'account_grant_service_of_vendor',
      sql.raw(serviceBelongsToVendorSql('service', 'vendor')),
    ),
    index('account_grant_group_service').on(t.agentGroupId, t.service),
  ],
)

export const defaultAccount = sqliteTable(
  'default_account',
  {
    agentGroupId: text('agent_group_id').notNull(),
    service: text('service').$type<ServiceId>().notNull(),
    accountId: text('account_id').notNull(),
    vendor: text('vendor').$type<VendorId>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentGroupId, t.service] }),
    foreignKey({
      columns: [t.agentGroupId, t.accountId, t.service],
      foreignColumns: [accountGrant.agentGroupId, accountGrant.accountId, accountGrant.service],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId, t.vendor],
      foreignColumns: [account.id, account.vendor],
    }).onDelete('cascade'),
  ],
)
