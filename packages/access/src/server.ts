import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db, type KurumiContext } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { z } from 'zod'

import { contract, createUserInput, type Principal } from './contract.ts'
import { user, userRole } from './schema.ts'

export { migrations } from '../migrations/index.ts'

export type User = typeof user.$inferSelect

export type AccessLedger = {
  principalOf(caller: Caller): Principal | null
  isOwner(caller: Caller): boolean
  isApprover(caller: Caller, approvers: readonly Principal[]): boolean
  /** Scoped admins of the group, then global admins, then owners, then the host. */
  approverChain(agentGroupId: string | null): Principal[]
  createUser(input: z.input<typeof createUserInput>): User
}

const tierOf = (role: { role: 'owner' | 'admin'; agentGroupId: string | null }): number =>
  role.agentGroupId !== null ? 0 : role.role === 'admin' ? 1 : 2

function principalOf(caller: Caller): Principal | null {
  switch (caller.kind) {
    case 'host':
      return { kind: 'host' }
    case 'human':
      return { kind: 'user', userId: caller.userId }
    case 'agent':
      return null
  }
}

function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === 'host' ? b.kind === 'host' : b.kind === 'user' && a.userId === b.userId
}

export function createAccessLedger({ db }: { db: Db }): AccessLedger {
  return {
    principalOf,
    isOwner(caller) {
      switch (caller.kind) {
        case 'host':
          return true
        case 'agent':
          return false
        case 'human':
          return (
            db
              .select({ userId: userRole.userId })
              .from(userRole)
              .where(
                and(
                  eq(userRole.userId, caller.userId),
                  eq(userRole.role, 'owner'),
                  isNull(userRole.agentGroupId),
                ),
              )
              .get() !== undefined
          )
      }
    },
    isApprover(caller, approvers) {
      const principal = principalOf(caller)
      return principal !== null && approvers.some((approver) => samePrincipal(approver, principal))
    },
    approverChain(agentGroupId) {
      const scoped =
        agentGroupId === null
          ? undefined
          : and(eq(userRole.role, 'admin'), eq(userRole.agentGroupId, agentGroupId))
      const roles = db
        .select({
          userId: userRole.userId,
          role: userRole.role,
          agentGroupId: userRole.agentGroupId,
        })
        .from(userRole)
        .where(or(isNull(userRole.agentGroupId), scoped))
        .orderBy(userRole.grantedAt, userRole.userId)
        .all()
        .toSorted((a, b) => tierOf(a) - tierOf(b))
      const userIds = [...new Set(roles.map((role) => role.userId))]
      return [...userIds.map((userId): Principal => ({ kind: 'user', userId })), { kind: 'host' }]
    },
    createUser(input) {
      const parsed = createUserInput.safeParse(input)
      if (!parsed.success) throw new ORPCError('BAD_REQUEST', { message: parsed.error.message })
      const { id, displayName } = parsed.data
      const kind = id.slice(0, id.indexOf(':'))
      return transaction(db, (tx) => {
        tx.insert(user).values({ id, kind, displayName }).onConflictDoNothing().run()
        const row = tx.select().from(user).where(eq(user.id, id)).get()
        if (row === undefined) throw new Error(`user ${id} vanished inside its own transaction`)
        return row
      })
    },
  }
}

const os = implement(contract).$context<KurumiContext & { accessLedger: AccessLedger }>()

export const router = os.router({
  users: {
    create: os.users.create.handler(({ context, input }) => context.accessLedger.createUser(input)),
  },
})
