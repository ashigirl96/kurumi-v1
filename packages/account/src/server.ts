import { agentGroup } from '@kurumi/agent/schema'
import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db, type KurumiContext, type Tx } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
  authModesOf,
  defaultAuthModeOf,
  placementOf,
  selectorShapeOf,
  serviceFor,
  serviceIds,
  servicesOf,
  serviceSpec,
  vendorOf,
  type AuthMode,
  type KeyVendorId,
  type ServiceId,
  type VendorId,
} from './catalog.ts'
import { contract } from './contract.ts'
import { account, accountGrant, defaultAccount } from './schema.ts'
import {
  accountHandle,
  groupSelector,
  parseAccountHandle,
  readSelector,
  selectAccount,
  unnamedIfGroupSelector,
  type AccountHandle,
  type GrantedCandidate,
  type SelectionRefusal,
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

const accountMaterial = z.object({ kind: z.literal('key'), key: z.string() })

export type AccountMaterial = z.infer<typeof accountMaterial>

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

export type EgressRequest = {
  host: string
  method: string
  path: string
  headers: Headers
  rawHeaders: readonly string[]
}

export type CredentialRefusal =
  | SelectionRefusal
  | { code: 'duplicate_slot'; service: ServiceId; header: string }
  | { code: 'method_not_allowed'; service: ServiceId; method: string; allowed: readonly string[] }

export type Injection = {
  readonly handle: AccountHandle
  readonly accountId: string
  /** Rewrites the request this decision was made for: every slot header of the service removed, the account's one slot set. */
  apply(): { path: string; headers: Headers }
  toJSON(): never
}

export type CredentialDecision =
  | { kind: 'inject'; injection: Injection }
  | { kind: 'refuse'; refusal: CredentialRefusal }
  | { kind: 'pass' }

export type CredentialPrincipal = { agentGroupId: string }

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
  credentialFor(principal: CredentialPrincipal, request: EgressRequest): CredentialDecision
  containerEnv(agentGroupId: string): Record<string, string>
}

type GrantRow = GrantedCandidate & Pick<typeof account.$inferSelect, 'authMode' | 'material'>

function slotHeadersOf(service: ServiceId): string[] {
  const slots = [
    serviceSpec(service).slot,
    ...authModesOf(vendorOf(service)).map((mode) => placementOf(service, mode).slot),
  ]
  const named = slots.flatMap((slot) => (slot.kind === 'header' ? [slot.header.toLowerCase()] : []))
  return [...new Set(['authorization', ...named])]
}

/** Some servers read `_` as `-` in a header name, so `x_api_key` would be a second key beside the injected one. */
const slotNameOf = (header: string): string => header.toLowerCase().replaceAll('_', '-')

function duplicatedHeader(
  headers: readonly string[],
  rawHeaders: readonly string[],
): string | undefined {
  const lines = new Map<string, number>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    if (name === undefined) continue
    const slot = slotNameOf(name)
    lines.set(slot, (lines.get(slot) ?? 0) + 1)
  }
  return headers.find((header) => (lines.get(header) ?? 0) > 1)
}

/** TRACE and its kin echo the request back, credential included. */
const credentialedMethods: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

/** Anthropic refuses an OAuth bearer unless the request opts into this beta, which a client set up for an API key leaves out. */
const optInOf: Partial<Record<AuthMode, { header: string; token: string }>> = {
  'oauth-token': { header: 'anthropic-beta', token: 'oauth-2025-04-20' },
}

function optedIn(value: string | null, token: string): string {
  if (value === null) return token
  return value.split(',').some((listed) => listed.trim() === token) ? value : `${value},${token}`
}

function keyOf(vaultKey: Uint8Array, row: GrantRow): string | null {
  let plaintext: unknown
  try {
    plaintext = JSON.parse(open(vaultKey, row.accountId, row.material))
  } catch (error) {
    if (error instanceof VaultError || error instanceof SyntaxError) return null
    throw error
  }
  const material = accountMaterial.safeParse(plaintext)
  return material.success ? material.data.key : null
}

const pathWithoutQuery = (path: string): string => {
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

function injectionFor({
  service,
  slotHeaders,
  row,
  secret,
  stripped,
  requested,
}: {
  service: ServiceId
  slotHeaders: readonly string[]
  row: GrantRow
  secret: string
  stripped: { headers: Headers; url: URL }
  requested: { path: string; url: URL }
}): Injection {
  const { slot } = placementOf(service, row.authMode)
  const optIn = row.authMode === null ? undefined : optInOf[row.authMode]
  return Object.freeze({
    handle: row.handle,
    accountId: row.accountId,
    apply() {
      const headers = new Headers(
        [...stripped.headers].filter(([name]) => !slotHeaders.includes(slotNameOf(name))),
      )
      const url = new URL(stripped.url)
      if (optIn) headers.set(optIn.header, optedIn(headers.get(optIn.header), optIn.token))
      switch (slot.kind) {
        case 'bearer':
          headers.set('authorization', `Bearer ${secret}`)
          break
        case 'header':
          headers.set(slot.header, secret)
          break
        case 'basic':
          headers.set(
            'authorization',
            `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`,
          )
          break
        case 'query':
          url.searchParams.set(slot.param, secret)
          break
        default: {
          const unknown: never = slot
          return unknown
        }
      }
      const path =
        url.search === requested.url.search
          ? requested.path
          : `${pathWithoutQuery(requested.path)}${url.search}`
      return { path, headers }
    },
    toJSON(): never {
      throw new Error('an Injection holds a credential and cannot be serialized')
    },
  })
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

const containerEnvServices = serviceIds.filter((service) =>
  authModesOf(vendorOf(service)).some(
    (mode) => placementOf(service, mode).containerEnv !== undefined,
  ),
)

function unnamedRequestAuthMode(service: ServiceId, rows: readonly GrantRow[]): AuthMode | null {
  const selection = selectAccount(service, rows, { kind: 'none' })
  const chosen = selection.ok
    ? rows.find((row) => row.accountId === selection.accountId)
    : undefined
  if (chosen) return chosen.authMode
  const [first, ...others] = rows
  if (first && others.every((row) => row.authMode === first.authMode)) return first.authMode
  return defaultAuthModeOf(vendorOf(service))
}

export function createAccountLedger(deps: { db: Db; vaultKey: Uint8Array }): AccountLedger {
  const grantRowsQuery = deps.db
    .select({
      accountId: account.id,
      vendor: account.vendor,
      label: account.label,
      status: account.status,
      authMode: account.authMode,
      material: account.material,
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

  const grantRows = (agentGroupId: string, service: ServiceId): GrantRow[] =>
    grantRowsQuery.all({ agentGroupId, service }).map((row) => ({
      accountId: row.accountId,
      handle: accountHandle(row.vendor, row.label),
      isDefault: row.defaultAccountId !== null,
      status: row.status,
      authMode: row.authMode,
      material: row.material,
    }))

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
      return grantRows(agentGroupId, service).map(({ accountId, handle, isDefault, status }) => ({
        accountId,
        handle,
        isDefault,
        status,
      }))
    },

    credentialFor({ agentGroupId }, request) {
      const located = serviceFor(request.host, request.path)
      if (!located) return { kind: 'pass' }
      const { vendor, service } = located
      if (!credentialedMethods.includes(request.method)) {
        return {
          kind: 'refuse',
          refusal: {
            code: 'method_not_allowed',
            service,
            method: request.method,
            allowed: credentialedMethods,
          },
        }
      }
      const slotHeaders = slotHeadersOf(service)
      const header = duplicatedHeader(slotHeaders, request.rawHeaders)
      if (header !== undefined) {
        return { kind: 'refuse', refusal: { code: 'duplicate_slot', service, header } }
      }
      // A base URL would read a path such as `/\other.example` as another host.
      const url = new URL(`https://${request.host}${request.path}`)
      const { selector, stripped } = readSelector(
        selectorShapeOf(vendor),
        serviceSpec(service).slot,
        { headers: request.headers, url },
      )
      const rows = grantRows(agentGroupId, service)
      const selection = selectAccount(service, rows, unnamedIfGroupSelector(vendor, selector))
      if (!selection.ok) return { kind: 'refuse', refusal: selection.refusal }
      const row = rows.find(({ accountId }) => accountId === selection.accountId)
      if (!row) throw new Error(`${selection.handle} was chosen from outside the grant rows`)
      const secret = keyOf(deps.vaultKey, row)
      if (secret === null) {
        return {
          kind: 'refuse',
          refusal: { code: 'account_needs_reauth', service, handle: row.handle },
        }
      }
      return {
        kind: 'inject',
        injection: injectionFor({
          service,
          slotHeaders,
          row,
          secret,
          stripped,
          requested: { path: request.path, url },
        }),
      }
    },

    containerEnv(agentGroupId) {
      return Object.fromEntries(
        containerEnvServices.flatMap((service) => {
          const mode = unnamedRequestAuthMode(service, grantRows(agentGroupId, service))
          const env = placementOf(service, mode).containerEnv?.(groupSelector(vendorOf(service)))
          return Object.entries(env ?? {})
        }),
      )
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
