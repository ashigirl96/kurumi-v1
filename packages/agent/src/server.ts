import { dlopen } from 'bun:ffi'
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
import { basename, join, resolve } from 'node:path'

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

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  openat: { args: ['int', 'ptr', 'int'], returns: 'int' },
  linkat: { args: ['int', 'ptr', 'int', 'ptr', 'int'], returns: 'int' },
  mkdirat: { args: ['int', 'ptr', 'int'], returns: 'int' },
})
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const memoryLimit = 16000

type MemoryTemplates = Record<'memory' | 'system', string>

function openAt(parent: number, name: string, flags: number): number {
  const fd = libc.symbols.openat(parent, Buffer.from(`${name}\0`), flags)
  if (fd < 0) throw new Error('unsafe_or_unreadable')
  return fd
}

function openMemoryIndex(
  folder: string,
  directory: keyof MemoryTemplates,
  template: string,
): number {
  const groups = openSync(resolve(folder, '..'), directoryFlags)
  let workspace: number | undefined
  let memory: number | undefined
  try {
    // Descriptor-relative operations keep concurrent renames from redirecting host reads or writes.
    workspace = openAt(groups, basename(folder), directoryFlags)
    libc.symbols.mkdirat(workspace, Buffer.from(`${directory}\0`), 0o700)
    memory = openAt(workspace, directory, directoryFlags)
    const existing = libc.symbols.openat(memory, Buffer.from('index.md\0'), readFlags)
    if (existing >= 0) return existing
    const temporary = join(resolve(folder, '..'), `.memory-${crypto.randomUUID()}`)
    const created = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(created, template, 'utf8')
      // linkat creates only an absent index, without following its entry or re-resolving its directory.
      libc.symbols.linkat(
        groups,
        Buffer.from(`${basename(temporary)}\0`),
        memory,
        Buffer.from('index.md\0'),
        0,
      )
    } finally {
      closeSync(created)
      rmSync(temporary)
    }
    return openAt(memory, 'index.md', readFlags)
  } finally {
    if (memory !== undefined) closeSync(memory)
    if (workspace !== undefined) closeSync(workspace)
    closeSync(groups)
  }
}

function instructionAt(
  path: string,
  open: () => number,
  limit: number,
  log: (entry: InstructionLog) => void,
): string {
  let fd: number | undefined
  try {
    fd = open()
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      log({ kind: 'agent.instructions.omitted', path, reason: 'not_regular' })
      return ''
    }
    // Four UTF-8 bytes per code point, plus one code point to detect truncation.
    const buffer = Buffer.alloc((limit + 1) * 4)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length), {
      stream: length < stat.size,
    })
    const text = Array.from(decoded).slice(0, limit).join('')
    const droppedBytes = Math.max(0, stat.size - Buffer.byteLength(text))
    if (droppedBytes > 0) log({ kind: 'agent.instructions.truncated', path, droppedBytes })
    return text
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
  memoryTemplates = { memory: '', system: '' },
  log = () => {},
}: {
  db: Db
  home: string
  baseInstructions?: string
  memoryTemplates?: MemoryTemplates
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
      const folder = join(groups, group.folder)
      const memory = (['memory', 'system'] satisfies (keyof MemoryTemplates)[]).map((directory) => {
        const text = instructionAt(
          join(folder, directory, 'index.md'),
          () => openMemoryIndex(folder, directory, memoryTemplates[directory]),
          memoryLimit,
          log,
        )
        return text ? `### ${directory}/index.md\n\n${text}` : ''
      })
      const persona = join(folder, 'instructions.prepend.md')
      return [
        `Your name is ${group.name}.`,
        instructionAt(
          persona,
          () => {
            checkWorkspace(folder)
            return openSync(persona, readFlags)
          },
          personaLimit,
          log,
        ),
        baseInstructions,
        ...memory,
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
