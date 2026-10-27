import { agentGroup } from '@kurumi/agent/schema'
import type { Tx } from '@kurumi/rpc/server'
import { eq } from 'drizzle-orm'

import type { ServiceId } from './catalog.ts'
import { account, accountGrant } from './schema.ts'

export type GrantKey = { agentGroupId: string; accountId: string; service: ServiceId }

export type GrantInput = GrantKey & { grantedBy: string }

export type GrantRefusal = 'agent_group_not_found' | 'account_not_found' | 'service_not_covered'

export type GrantResult = { ok: true } | { ok: false; refusal: GrantRefusal }

export function grant(
  tx: Tx,
  { agentGroupId, accountId, service, grantedBy }: GrantInput,
): GrantResult {
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
