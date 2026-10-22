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

/**
 * One identity at one vendor: a Google login, a Notion workspace, a pasted Anthropic key. Google is one row;
 * Gmail and Calendar are services it covers. The handle an agent uses is `${vendor}/${label}`, derived and never
 * stored.
 */
export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    vendor: text('vendor').$type<VendorId>().notNull(),
    label: text('label').notNull(),
    /** The vendor's stable account id, so reconnecting the same login updates this row instead of adding one. */
    subject: text('subject'),
    kind: text('kind', { enum: ['oauth', 'key'] }).notNull(),
    /** Services the stored credential can call: those its granted scopes cover, every service for a key vendor. */
    services: text('services', { mode: 'json' }).$type<ServiceId[]>().notNull(),
    /** AES-256-GCM of the credential under the vault key. Never leaves the account package. */
    material: blob('material', { mode: 'buffer' }).notNull(),
    accessExpiresAt: integer('access_expires_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['active', 'needs_reauth'] }).notNull(),
    /** Granted, with all its services, to every Agent Group on creation. Off by default. */
    autoGrant: integer('auto_grant', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('account_vendor_label').on(t.vendor, t.label),
    uniqueIndex('account_vendor_subject').on(t.vendor, t.subject),
    // the target of the composite FKs below, so a grant or a default can only name an account of its own vendor
    uniqueIndex('account_id_vendor').on(t.id, t.vendor),
  ],
)

/**
 * An Agent Group may use one service of one account. Many to many, denied by default, and the only place a grant
 * exists. The database holds service in vendor (a CHECK built from the catalog) and vendor equal to the account's
 * vendor (an FK). `grant` in server.ts holds service in account.services, which is JSON and so not a constraint.
 */
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

/**
 * At most one default account per group and service, which is the primary key. It must be granted for that
 * service (an FK to the grant, so a revoke removes it) and belong to the account's vendor (an FK to the account).
 */
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
