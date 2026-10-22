import { agentGroup } from '@kurumi/agent/schema'
import type { Db, Tx } from '@kurumi/rpc/server'
import { and, eq, sql } from 'drizzle-orm'

import { type ServiceId, type VendorId } from './catalog.ts'
import { account, accountGrant, defaultAccount } from './schema.ts'
import { accountHandle, type GrantedCandidate } from './select.ts'

export { migrations } from '../migrations/index.ts'
export { accountHandle, selectAccount } from './select.ts'
export type {
  AccountHandle,
  GrantedCandidate,
  Selection,
  SelectionRefusal,
  Selector,
} from './select.ts'
export type { ServiceId, VendorId }

export type GrantKey = { agentGroupId: string; accountId: string; service: ServiceId }

export type GrantInput = GrantKey & { grantedBy: string }

export type GrantRefusal = 'agent_group_not_found' | 'account_not_found' | 'service_not_covered'

export type GrantResult = { ok: true } | { ok: false; refusal: GrantRefusal }

export type SetDefaultResult = { ok: true } | { ok: false; refusal: 'grant_not_found' }

export type AccountLedger = {
  grant(tx: Tx, input: GrantInput): GrantResult
  revoke(tx: Tx, input: GrantKey): void
  setDefault(tx: Tx, input: GrantKey): SetDefaultResult
  candidates(agentGroupId: string, service: ServiceId): GrantedCandidate[]
}

export function createAccountLedger(deps: { db: Db }): AccountLedger {
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
    grant(tx, { agentGroupId, accountId, service, grantedBy }) {
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
