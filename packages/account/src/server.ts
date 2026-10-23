import { agentGroup } from '@kurumi/agent/schema'
import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db, type KurumiContext, type Tx } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
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
import { contract } from './contract.ts'
import { account, accountGrant, defaultAccount } from './schema.ts'
import {
  accountHandle,
  parseAccountHandle,
  type AccountHandle,
  type GrantedCandidate,
} from './select.ts'
import { open, seal, VaultError } from './vault.ts'

export { migrations } from '../migrations/index.ts'
export { isInterceptedHost } from './catalog.ts'
export { open, seal, VaultError } from './vault.ts'
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

const AUTO_GRANT = 'auto-grant'

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

export type StoredAccounts = { count: number; sealedWith: (vaultKey: Uint8Array) => boolean }

export function storedAccounts(db: Db): StoredAccounts {
  const sealed = db.select({ id: account.id, material: account.material }).from(account).all()
  return {
    count: sealed.length,
    sealedWith: (vaultKey) =>
      sealed.length === 0 || sealed.some(({ id, material }) => opens(vaultKey, id, material)),
  }
}

function opens(vaultKey: Uint8Array, accountId: string, material: Uint8Array): boolean {
  try {
    open(vaultKey, accountId, material)
    return true
  } catch (error) {
    if (error instanceof VaultError) return false
    throw error
  }
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
    addKey(tx, { vendor, label, authMode, value, autoGrant }) {
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
            grant(tx, { agentGroupId: group.id, accountId: id, service, grantedBy: AUTO_GRANT })
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
          grant(tx, { agentGroupId, accountId: id, service, grantedBy: AUTO_GRANT })
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

type Refusal = AddKeyRefusal | HandleRefusal | GrantRefusal | 'grant_not_found'

type RefusalSubject = {
  handle: string
  authMode?: AuthMode
  service?: ServiceId
  agentGroupId?: string
}

function refusalError(
  refusal: Refusal,
  { handle, authMode, service, agentGroupId }: RefusalSubject,
): ORPCError<string, unknown> {
  switch (refusal) {
    case 'label_taken':
      return new ORPCError('CONFLICT', { message: `${handle} already exists` })
    case 'account_not_found':
      return new ORPCError('NOT_FOUND', { message: `no account ${handle}` })
    case 'agent_group_not_found':
      return new ORPCError('NOT_FOUND', { message: `no agent group ${agentGroupId}` })
    case 'invalid_handle':
      return new ORPCError('BAD_REQUEST', {
        message: `${handle} is not <vendor>/<label> with a known vendor`,
      })
    case 'auth_mode_not_supported': {
      const vendor = parseAccountHandle(handle)?.vendor
      const modes = vendor ? authModesOf(vendor) : []
      const accepted = modes.length > 0 ? `use one of ${modes.join(', ')}` : 'it takes none'
      return new ORPCError('BAD_REQUEST', {
        message: `${vendor} has no auth mode ${authMode}; ${accepted}`,
      })
    }
    case 'service_not_covered':
      return new ORPCError('BAD_REQUEST', { message: `${handle} does not cover ${service}` })
    case 'grant_not_found':
      return new ORPCError('BAD_REQUEST', {
        message: `${handle} is not granted ${service} for ${agentGroupId}`,
      })
  }
}

function actorOf(caller: Caller): string {
  switch (caller.kind) {
    case 'host':
      return 'host'
    case 'human':
      return `human:${caller.userId}`
    case 'agent':
      throw new ORPCError('FORBIDDEN', { message: 'agents may not change accounts' })
  }
}

function existingAccountId(ledger: AccountLedger, tx: Tx, handle: string): string {
  const found = ledger.accountIdOf(tx, handle)
  if (!found.ok) throw refusalError(found.refusal, { handle })
  return found.accountId
}

const os = implement(contract).$context<KurumiContext & { accountLedger: AccountLedger }>()

export const router = os.router({
  addKey: os.addKey.handler(({ context, input: [vendor, { label, auth, autoGrant, value }] }) => {
    const result = transaction(context.db, (tx) =>
      context.accountLedger.addKey(tx, { vendor, label, authMode: auth, value, autoGrant }),
    )
    if (!result.ok)
      throw refusalError(result.refusal, { handle: `${vendor}/${label}`, authMode: auth })
    return { handle: result.handle }
  }),
  list: os.list.handler(({ context }) => context.accountLedger.list()),
  remove: os.remove.handler(({ context, input: [handle] }) => {
    transaction(context.db, (tx) => {
      const result = context.accountLedger.remove(tx, handle)
      if (!result.ok) throw refusalError(result.refusal, { handle })
    })
  }),
  grant: os.grant.handler(({ context, input: [handle, { service, agentGroupId }] }) => {
    const grantedBy = actorOf(context.caller)
    transaction(context.db, (tx) => {
      const ledger = context.accountLedger
      const accountId = existingAccountId(ledger, tx, handle)
      const result = ledger.grant(tx, { agentGroupId, accountId, service, grantedBy })
      if (!result.ok) throw refusalError(result.refusal, { handle, service, agentGroupId })
    })
  }),
  revoke: os.revoke.handler(({ context, input: [handle, { service, agentGroupId }] }) => {
    transaction(context.db, (tx) => {
      const ledger = context.accountLedger
      const accountId = existingAccountId(ledger, tx, handle)
      ledger.revoke(tx, { agentGroupId, accountId, service })
    })
  }),
  setDefault: os.setDefault.handler(({ context, input: [handle, { service, agentGroupId }] }) => {
    transaction(context.db, (tx) => {
      const ledger = context.accountLedger
      const accountId = existingAccountId(ledger, tx, handle)
      const result = ledger.setDefault(tx, { agentGroupId, accountId, service })
      if (!result.ok) throw refusalError(result.refusal, { handle, service, agentGroupId })
    })
  }),
  clearDefault: os.clearDefault.handler(({ context, input }) => {
    transaction(context.db, (tx) => {
      context.accountLedger.clearDefault(tx, input)
    })
  }),
})
