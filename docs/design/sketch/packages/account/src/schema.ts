// @kurumi/account/schema
import { agentGroup } from '@kurumi/agent/schema'
import { session } from '@kurumi/session/schema'
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
 * One identity at one vendor: a Google login, a Notion workspace, a pasted Anthropic key. Google is ONE row;
 * Gmail and Calendar are services it covers. The Account Handle the agent uses is `${vendor}/${label}`;
 * it is derived, never stored.
 */
export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(), // acc-<uuidv7>
    vendor: text('vendor').$type<VendorId>().notNull(),
    label: text('label').notNull(), // email, workspace name, or a human-given name for keys
    /** Vendor's stable account id; reconnecting the same login updates this row instead of adding one. */
    subject: text('subject'),
    kind: text('kind', { enum: ['oauth', 'key'] }).notNull(),
    /** Services the stored credential can call (from granted scopes; every service for key vendors). */
    services: text('services', { mode: 'json' }).$type<ServiceId[]>().notNull(),
    /** AES-256-GCM(JSON AccountMaterial) under the vault key. Never leaves the account package. */
    material: blob('material', { mode: 'buffer' }).notNull(),
    accessExpiresAt: integer('access_expires_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['active', 'needs_reauth'] }).notNull(),
    /** Granted (all its services) to every Agent Group on creation — the model key. Explicit, off by default. */
    autoGrant: integer('auto_grant', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('account_vendor_label').on(t.vendor, t.label),
    uniqueIndex('account_vendor_subject').on(t.vendor, t.subject),
    // target of the composite FKs below: a grant or default can only name an account of its own vendor
    uniqueIndex('account_id_vendor').on(t.id, t.vendor),
  ],
)

/**
 * Agent Group may use one service of one account. Many-to-many, default deny, the only place a grant exists.
 * Group 1 = (A, gmail) (B, gmail) (C, gmail); Group 2 = (B, gmail) (A, google-calendar).
 * DB: service ∈ vendor (CHECK generated from the catalog), vendor = account's vendor (FK).
 * Code (`grant` in server.ts, one function): service ∈ account.services — JSON, so not a constraint.
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
    grantedBy: text('granted_by').notNull(), // Caller rendered as text, for audit
    grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentGroupId, t.accountId, t.service] }),
    foreignKey({ columns: [t.accountId, t.vendor], foreignColumns: [account.id, account.vendor] }).onDelete('cascade'),
    check('account_grant_service_of_vendor', sql.raw(serviceBelongsToVendorSql('service', 'vendor'))),
    index('account_grant_group_service').on(t.agentGroupId, t.service),
  ],
)

/**
 * At most one Default Account per (group, service) — the PK. It must be granted for that service (FK to the
 * grant row, cascades on revoke) and belong to the account's vendor (FK to account(id, vendor)).
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
    foreignKey({ columns: [t.accountId, t.vendor], foreignColumns: [account.id, account.vendor] }).onDelete('cascade'),
  ],
)

/** BYOC OAuth client per vendor. Secret is vault-encrypted. */
export const oauthClient = sqliteTable('oauth_client', {
  vendor: text('vendor').$type<VendorId>().primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecret: blob('client_secret', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * In-chat (or Console/CLI) connection in flight. The account domain is its only writer.
 * Shape per state is enforced by `parseConnectionRequest` (connect.ts); illegal combinations fail the parse.
 */
export const connectionRequest = sqliteTable(
  'connection_request',
  {
    id: text('id').primaryKey(), // cr-<uuidv7>
    agentGroupId: text('agent_group_id')
      .notNull()
      .references(() => agentGroup.id, { onDelete: 'cascade' }),
    vendor: text('vendor').$type<VendorId>().notNull(),
    /** Services asked for; one consent requests the union of their scopes. Granted on completion. */
    services: text('services', { mode: 'json' }).$type<ServiceId[]>().notNull(),
    /** Set when an agent asked from a chat: the card lives there and the session is resumed on completion. */
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    cardMessageId: text('card_message_id'), // outbound_message.id of the Connect Card
    requestedBy: text('requested_by').notNull(),
    state: text('state', { enum: ['open', 'authorizing', 'completed', 'expired', 'cancelled'] }).notNull(),
    /** Random, single use; the OAuth `state` param. Lookup key of the callback. */
    oauthState: text('oauth_state').unique(),
    pkceVerifier: blob('pkce_verifier', { mode: 'buffer' }), // vault-encrypted
    accountId: text('account_id').references(() => account.id, { onDelete: 'set null' }),
    lastError: text('last_error'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    // one live request per (group, vendor, chat session): the agent asking twice gets the same card
    uniqueIndex('connection_request_live')
      .on(t.agentGroupId, t.vendor, t.sessionId)
      .where(sql`state in ('open','authorizing')`),
  ],
)

/**
 * One-time entry to the OAuth flow, minted for the person who pressed the card's Connect button after the host
 * checked they are an approver of the group. Only the hash is stored. 5 minutes, single use.
 * The card itself never carries a URL, so a bystander in a shared channel cannot start the flow.
 */
export const connectLink = sqliteTable('connect_link', {
  tokenHash: blob('token_hash', { mode: 'buffer' }).primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => connectionRequest.id, { onDelete: 'cascade' }),
  mintedFor: text('minted_for').notNull(), // userId, or 'host' for the CLI
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
})
