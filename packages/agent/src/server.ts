import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { transaction, type Db, type KurumiContext, type Tx } from '@kurumi/rpc/server'
import { implement, ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'

import { contract, createAgentInput, personaLimit, updateAgentInput } from './contract.ts'
import { agentGroup } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export type { AgentGroupId } from './contract.ts'

export type InstructionLog =
  | { kind: 'agent.instructions.omitted'; path: string; reason: string }
  | { kind: 'agent.instructions.truncated'; path: string; droppedBytes: number }

function checkWorkspace(folder: string): void {
  // The container can edit workspace entries, but its host-owned parent is not mounted.
  for (const path of [resolve(folder, '..'), folder]) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    closeSync(fd)
  }
}

function personaAt(folder: string, log: (entry: InstructionLog) => void): string {
  const path = join(folder, 'instructions.prepend.md')
  let fd: number | undefined
  try {
    checkWorkspace(folder)
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      log({ kind: 'agent.instructions.omitted', path, reason: 'not_regular' })
      return ''
    }
    // Four UTF-8 bytes per code point, plus one code point to detect truncation.
    const buffer = Buffer.alloc((personaLimit + 1) * 4)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length), {
      stream: length < stat.size,
    })
    const persona = Array.from(decoded).slice(0, personaLimit).join('')
    const droppedBytes = Math.max(0, stat.size - Buffer.byteLength(persona))
    if (droppedBytes > 0) log({ kind: 'agent.instructions.truncated', path, droppedBytes })
    return persona
  } catch (error) {
    const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable'
    if (reason !== 'ENOENT') log({ kind: 'agent.instructions.omitted', path, reason })
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export type AgentGroup = typeof agentGroup.$inferSelect
export type AgentLedger = {
  create(input: z.input<typeof createAgentInput>): AgentGroup
  update(input: z.input<typeof updateAgentInput>): AgentGroup
  prepareWorkspace(agentGroupId: string): string
  list(): AgentGroup[]
  get(agentGroupId: string): AgentGroup | undefined
}

export function createAgentLedger({
  db,
  home,
  onCreate,
  baseInstructions = '',
  log = () => {},
}: {
  db: Db
  home: string
  baseInstructions?: string
  log?: (entry: InstructionLog) => void
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
    update(input) {
      const parsed = updateAgentInput.safeParse(input)
      if (!parsed.success) throw new ORPCError('BAD_REQUEST', { message: parsed.error.message })
      const { agentGroupId: id, persona } = parsed.data
      const group = db.select().from(agentGroup).where(eq(agentGroup.id, id)).get()
      if (!group) throw new ORPCError('NOT_FOUND', { message: 'agent group not found' })
      const folder = join(groups, group.folder)
      checkWorkspace(folder)
      const path = join(folder, 'instructions.prepend.md')
      const previous = lstatSync(path, { throwIfNoEntry: false })
      if (previous && !previous.isFile())
        throw new ORPCError('BAD_REQUEST', { message: `persona must be a regular file: ${path}` })
      const temporary = join(folder, `.persona-${crypto.randomUUID()}`)
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeFileSync(fd, persona, 'utf8')
        renameSync(temporary, path)
      } finally {
        closeSync(fd)
        rmSync(temporary, { force: true })
      }
      return workspace(group)
    },
    prepareWorkspace(id) {
      const group = db.select().from(agentGroup).where(eq(agentGroup.id, id)).get()
      if (!group) throw new ORPCError('NOT_FOUND', { message: 'agent group not found' })
      return [
        `Your name is ${group.name}.`,
        personaAt(join(groups, group.folder), log),
        baseInstructions,
      ]
        .filter(Boolean)
        .join('\n\n')
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
  update: os.update.handler(({ context, input }) => context.agentLedger.update(input)),
  create: os.create.handler(({ context, input }) => context.agentLedger.create(input)),
})
