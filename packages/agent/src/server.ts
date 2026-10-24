import { mkdirSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { transaction, type Db, type KurumiContext, type Tx } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'

import { contract, createAgentInput } from './contract.ts'
import { agentGroup } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export type { AgentGroupId } from './contract.ts'

export type AgentGroup = typeof agentGroup.$inferSelect
export type AgentLedger = {
  create(input: z.input<typeof createAgentInput>): AgentGroup
  list(): AgentGroup[]
  get(agentGroupId: string): AgentGroup | undefined
}

export function createAgentLedger({
  db,
  home,
  onCreate,
}: {
  db: Db
  home: string
  /** Runs in the create transaction, so a throw rolls the new group back. */
  onCreate?: (tx: Tx, agentGroupId: string) => void
}): AgentLedger {
  const groups = resolve(home, 'groups')
  const workspace = (group: AgentGroup): AgentGroup => ({
    ...group,
    folder: join(groups, group.folder),
  })

  return {
    create(input) {
      const parsed = createAgentInput.safeParse(input)
      if (!parsed.success) throw new ORPCError('BAD_REQUEST', { message: parsed.error.message })
      const { name, folder = name } = parsed.data
      const group: AgentGroup = {
        id: `ag-${crypto.randomUUID()}`,
        name,
        folder,
        createdAt: new Date(),
      }
      const path = join(groups, folder)
      mkdirSync(groups, { recursive: true })
      try {
        mkdirSync(path)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw new ORPCError('CONFLICT', { message: `agent folder already exists: ${folder}` })
        }
        throw error
      }
      try {
        transaction(db, (tx) => {
          tx.insert(agentGroup).values(group).run()
          onCreate?.(tx, group.id)
        })
      } catch (error) {
        rmdirSync(path)
        throw error
      }
      return workspace(group)
    },
    list() {
      return db
        .select()
        .from(agentGroup)
        .orderBy(agentGroup.createdAt, agentGroup.id)
        .all()
        .map(workspace)
    },
    get(id) {
      const group = db.select().from(agentGroup).where(eq(agentGroup.id, id)).get()
      return group === undefined ? undefined : workspace(group)
    },
  }
}

const os = implement(contract).$context<KurumiContext & { agentLedger: AgentLedger }>()

export const router = os.router({
  list: os.list.handler(({ context }) => context.agentLedger.list()),
  create: os.create.handler(({ context, input }) => context.agentLedger.create(input)),
})
