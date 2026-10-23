import { agentGroup } from '@kurumi/agent/schema'
import type { Db, Tx } from '@kurumi/rpc/server'
import { and, eq, sql } from 'drizzle-orm'

import {
  authModesOf,
  defaultAuthModeOf,
  servicesOf,
  type AuthMode,
  type KeyVendorId,
  type ServiceId,
  type VendorId,
} from './catalog.ts'
import { account, accountGrant, defaultAccount } from './schema.ts'
import {
  accountHandle,
  parseAccountHandle,
  type AccountHandle,
  type GrantedCandidate,
} from './select.ts'
import { seal } from './vault.ts'

export { migrations } from '../migrations/index.ts'
export { accountHandle, parseAccountHandle, selectAccount } from './select.ts'
export type {
  AccountHandle,
  GrantedCandidate,
  Selection,
  SelectionRefusal,
  Selector,
} from './select.ts'
export type { AuthMode, KeyVendorId, ServiceId, VendorId }

export type GrantKey = { agentGroupId: string; accountId: string; service: ServiceId }

export type GrantInput = GrantKey & { grantedBy: string }

export type GrantRefusal = 'agent_group_not_found' | 'account_not_found' | 'service_not_covered'

export type GrantResult = { ok: true } | { ok: false; refusal: GrantRefusal }

export type SetDefaultResult = { ok: true } | { ok: false; refusal: 'grant_not_found' }

export type AccountMaterial = { kind: 'key'; key: string }

export type AddKeyInput = {
  vendor: KeyVendorId
  label: string
  authMode?: AuthMode
  value: string
  autoGrant: boolean
  addedBy: string
}

export type AddKeyRefusal = 'label_taken' | 'auth_mode_not_supported'

export type AddKeyResult =
  | { ok: true; handle: AccountHandle }
  | { ok: false; refusal: AddKeyRefusal }

export type HandleRefusal = 'invalid_handle' | 'account_not_found'

export type AccountLookup = { ok: true; accountId: string } | { ok: false; refusal: HandleRefusal }

export type RemoveResult = { ok: true } | { ok: false; refusal: HandleRefusal }

export type AccountView = {
  handle: AccountHandle
  kind: 'oauth' | 'key'
  authMode: AuthMode | null
  services: ServiceId[]
  autoGrant: boolean
}

export type AccountLedger = {
  addKey(tx: Tx, input: AddKeyInput): AddKeyResult
  remove(tx: Tx, handle: string): RemoveResult
  accountIdOf(tx: Tx, handle: string): AccountLookup
  list(): AccountView[]
  grant(tx: Tx, input: GrantInput): GrantResult
  grantAutoGrants(tx: Tx, agentGroupId: string): void
  revoke(tx: Tx, input: GrantKey): void
  setDefault(tx: Tx, input: GrantKey): SetDefaultResult
  clearDefault(tx: Tx, input: { agentGroupId: string; service: ServiceId }): void
  candidates(agentGroupId: string, service: ServiceId): GrantedCandidate[]
}

function accountIdOf(tx: Tx, handle: string): AccountLookup {
  const parsed = parseAccountHandle(handle)
  if (!parsed) return { ok: false, refusal: 'invalid_handle' }
  const found = tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.vendor, parsed.vendor), eq(account.label, parsed.label)))
    .get()
  return found ? { ok: true, accountId: found.id } : { ok: false, refusal: 'account_not_found' }
}

function grant(tx: Tx, { agentGroupId, accountId, service, grantedBy }: GrantInput): GrantResult {
  const group = tx
    .select({ id: agentGroup.id })
    .from(agentGroup)
    .where(eq(agentGroup.id, agentGroupId))
    .get()
  if (!group) return { ok: false, refusal: 'agent_group_not_found' }
  const held = tx
    .select({ vendor: account.vendor, services: account.services })
    .from(account)
    .where(eq(account.id, accountId))
    .get()
  if (!held) return { ok: false, refusal: 'account_not_found' }
  if (!held.services.includes(service)) return { ok: false, refusal: 'service_not_covered' }
  tx.insert(accountGrant)
    .values({
      agentGroupId,
      accountId,
      vendor: held.vendor,
      service,
      grantedBy,
      grantedAt: new Date(),
    })
    .onConflictDoNothing()
    .run()
  return { ok: true }
}

export function createAccountLedger(deps: { db: Db; vaultKey: Uint8Array }): AccountLedger {
  const candidatesQuery = deps.db
    .select({
      accountId: account.id,
      vendor: account.vendor,
      label: account.label,
      status: account.status,
      defaultAccountId: defaultAccount.accountId,
    })
    .from(accountGrant)
    .innerJoin(
      account,
      and(eq(account.id, accountGrant.accountId), eq(account.vendor, accountGrant.vendor)),
    )
    .leftJoin(
      defaultAccount,
      and(
        eq(defaultAccount.agentGroupId, accountGrant.agentGroupId),
        eq(defaultAccount.service, accountGrant.service),
        eq(defaultAccount.accountId, accountGrant.accountId),
      ),
    )
    .where(
      and(
        eq(accountGrant.agentGroupId, sql.placeholder('agentGroupId')),
        eq(accountGrant.service, sql.placeholder('service')),
      ),
    )
    .orderBy(account.label)
    .prepare()

  return {
    addKey(tx, { vendor, label, authMode, value, autoGrant, addedBy }) {
      const modes = authModesOf(vendor)
      if (authMode !== undefined && !modes.includes(authMode)) {
        return { ok: false, refusal: 'auth_mode_not_supported' }
      }
      const taken = tx
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.vendor, vendor), eq(account.label, label)))
        .get()
      if (taken) return { ok: false, refusal: 'label_taken' }
      const id = `acc-${Bun.randomUUIDv7()}`
      const services = servicesOf(vendor)
      const material: AccountMaterial = { kind: 'key', key: value }
      tx.insert(account)
        .values({
          id,
          vendor,
          label,
          subject: null,
          kind: 'key',
          authMode: authMode ?? defaultAuthModeOf(vendor),
          services,
          material: seal(deps.vaultKey, id, JSON.stringify(material)),
          status: 'active',
          autoGrant,
          createdAt: new Date(),
        })
        .run()
      if (autoGrant) {
        for (const group of tx.select({ id: agentGroup.id }).from(agentGroup).all()) {
          for (const service of services) {
            grant(tx, { agentGroupId: group.id, accountId: id, service, grantedBy: addedBy })
          }
        }
      }
      return { ok: true, handle: accountHandle(vendor, label) }
    },

    remove(tx, handle) {
      const found = accountIdOf(tx, handle)
      if (!found.ok) return found
      tx.delete(account).where(eq(account.id, found.accountId)).run()
      return { ok: true }
    },

    accountIdOf,

    list() {
      return deps.db
        .select({
          vendor: account.vendor,
          label: account.label,
          kind: account.kind,
          authMode: account.authMode,
          services: account.services,
          autoGrant: account.autoGrant,
        })
        .from(account)
        .all()
        .map(({ vendor, label, ...view }) => ({ handle: accountHandle(vendor, label), ...view }))
        .toSorted((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
    },

    grant,

    grantAutoGrants(tx, agentGroupId) {
      const autoGranted = tx
        .select({ id: account.id, services: account.services })
        .from(account)
        .where(eq(account.autoGrant, true))
        .all()
      for (const { id, services } of autoGranted) {
        for (const service of services) {
          grant(tx, { agentGroupId, accountId: id, service, grantedBy: 'auto-grant' })
        }
      }
    },

    revoke(tx, { agentGroupId, accountId, service }) {
      tx.delete(accountGrant)
        .where(
          and(
            eq(accountGrant.agentGroupId, agentGroupId),
            eq(accountGrant.accountId, accountId),
            eq(accountGrant.service, service),
          ),
        )
        .run()
    },

    setDefault(tx, { agentGroupId, accountId, service }) {
      const granted = tx
        .select({ vendor: accountGrant.vendor })
        .from(accountGrant)
        .where(
          and(
            eq(accountGrant.agentGroupId, agentGroupId),
            eq(accountGrant.accountId, accountId),
            eq(accountGrant.service, service),
          ),
        )
        .get()
      if (!granted) return { ok: false, refusal: 'grant_not_found' }
      tx.insert(defaultAccount)
        .values({ agentGroupId, service, accountId, vendor: granted.vendor })
        .onConflictDoUpdate({
          target: [defaultAccount.agentGroupId, defaultAccount.service],
          set: { accountId, vendor: granted.vendor },
        })
        .run()
      return { ok: true }
    },

    clearDefault(tx, { agentGroupId, service }) {
      tx.delete(defaultAccount)
        .where(
          and(eq(defaultAccount.agentGroupId, agentGroupId), eq(defaultAccount.service, service)),
        )
        .run()
    },

    candidates(agentGroupId, service) {
      return candidatesQuery.all({ agentGroupId, service }).map((row) => ({
        accountId: row.accountId,
        handle: accountHandle(row.vendor, row.label),
        isDefault: row.defaultAccountId !== null,
        status: row.status,
      }))
    },
  }
}
