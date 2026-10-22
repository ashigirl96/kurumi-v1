// @kurumi/access/server — Users, roles (owner / global admin / scoped admin), Agent Group members.
import type { Caller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext, Tx } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'

export type AccessLedger = {
  start(): void
  stop(): void
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }
  /** Sender resolver: upsert `<channel>:<handle>`. The first user ever paired becomes Owner. */
  upsertSender(tx: Tx, channel: string, handle: string, displayName: string): { userId: string }
  canAccess(userId: string, agentGroupId: string): boolean
  isOwner(caller: Caller): boolean
  /** In `approverChain(agentGroupId)`: may approve, connect accounts, and use existing accounts for the group. */
  isApprover(caller: Caller, agentGroupId: string): boolean
  /** Approver chain for a group: scoped admins → global admins → owners. Baked into approval rows. */
  approverChain(agentGroupId: string | null): string[]
  addMember(tx: Tx, userId: string, agentGroupId: string, addedBy: string): void
}

export function createAccessLedger(deps: { db: Db }): AccessLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { accessLedger: AccessLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  users: { list: os.users.list.handler(notImplemented), update: os.users.update.handler(notImplemented) },
  roles: {
    list: os.roles.list.handler(notImplemented),
    grant: os.roles.grant.handler(notImplemented),
    revoke: os.roles.revoke.handler(notImplemented),
  },
  members: {
    list: os.members.list.handler(notImplemented),
    add: os.members.add.handler(notImplemented),
    remove: os.members.remove.handler(notImplemented),
  },
})
