import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Db } from '@kurumi/rpc/server'
import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { agentGroup } from './schema.ts'
import { createAgentLedger, migrations, router } from './server.ts'

let sqlite: Database
let home: string
let db: Db
let ledger: ReturnType<typeof createAgentLedger>

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  home = mkdtempSync(join(tmpdir(), 'kurumi-agent-'))
  ledger = createAgentLedger({ db, home })
})

afterEach(() => {
  sqlite.close()
  rmSync(home, { recursive: true, force: true })
})

test('create and list persist an agent row and return its workspace path', async () => {
  const client = createRouterClient(router, {
    context: {
      db,
      agentLedger: ledger,
      caller: { kind: 'host' },
      guard: () => ({ kind: 'allow' }),
      grant: null,
    },
  })
  const created = await client.create({ name: 'work' })
  expect(created.id).toMatch(/^ag-/)
  expect(created.name).toBe('work')
  expect(created.folder).toBe(join(home, 'groups', 'work'))
  expect(existsSync(created.folder)).toBe(true)
  expect(db.select().from(agentGroup).all()).toEqual([{ ...created, folder: 'work' }])
  expect(await client.list()).toEqual([created])
  expect(ledger.get(created.id)).toEqual(created)
  expect(ledger.get('ag-missing')).toBeUndefined()
})

test('a duplicate name rejects creation without touching the existing row or workspace', () => {
  const created = ledger.create({ name: 'work' })
  writeFileSync(join(created.folder, 'keep.txt'), 'existing work')
  expect(() => ledger.create({ name: 'work' })).toThrow(/already exists/)
  expect(ledger.list()).toEqual([created])
  expect(readdirSync(join(home, 'groups'))).toEqual(['work'])
  expect(readFileSync(join(created.folder, 'keep.txt'), 'utf8')).toBe('existing work')
})

test('an existing folder without a row is refused and its files survive', () => {
  const folder = join(home, 'groups', 'reserved')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'keep.txt'), 'keep')
  expect(() => ledger.create({ name: 'work', folder: 'reserved' })).toThrow(/already exists/)
  expect(ledger.list()).toEqual([])
  expect(readFileSync(join(folder, 'keep.txt'), 'utf8')).toBe('keep')
})

test('a failed insert removes only the newly created empty workspace', () => {
  sqlite.run(
    "CREATE TRIGGER reject_agent BEFORE INSERT ON agent_group BEGIN SELECT RAISE(ABORT, 'write refused'); END",
  )
  expect(() => ledger.create({ name: 'work' })).toThrow(/write refused/)
  expect(ledger.list()).toEqual([])
  expect(readdirSync(join(home, 'groups'))).toEqual([])
})

test('the create hook sees the new group inside the transaction, and its throw rolls the group back', () => {
  const seen: string[] = []
  const hooked = createAgentLedger({
    db,
    home,
    onCreate(tx, agentGroupId) {
      seen.push(
        ...tx
          .select()
          .from(agentGroup)
          .all()
          .map(({ id }) => id),
      )
      if (agentGroupId === seen[0]) throw new Error('hook refused')
    },
  })

  expect(() => hooked.create({ name: 'work' })).toThrow(/hook refused/)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatch(/^ag-/)
  expect(ledger.list()).toEqual([])
  expect(readdirSync(join(home, 'groups'))).toEqual([])
})

test.each(['../escape', '/absolute', '.', '..', 'nested/folder', 'back\\slash', ''])(
  'folder %j cannot escape the groups directory',
  (folder) => {
    expect(() => ledger.create({ name: 'work', folder })).toThrow()
    expect(ledger.list()).toEqual([])
    expect(existsSync(join(home, 'groups', 'work'))).toBe(false)
  },
)

test('workspace instructions contain the agent name, persona, and trusted base in order', () => {
  const composed = createAgentLedger({ db, home, baseInstructions: 'Trusted base' })
  const agent = composed.create({ name: 'work' })
  writeFileSync(join(agent.folder, 'instructions.prepend.md'), 'Owner persona')
  const text = composed.prepareWorkspace(agent.id)
  expect(text.indexOf('work')).toBeGreaterThanOrEqual(0)
  expect(text.indexOf('Owner persona')).toBeGreaterThan(text.indexOf('work'))
  expect(text.indexOf('Trusted base')).toBeGreaterThan(text.indexOf('Owner persona'))
})

test('a missing persona keeps the name and base, and an unknown agent is refused', () => {
  const composed = createAgentLedger({ db, home, baseInstructions: 'Trusted base' })
  const agent = composed.create({ name: 'work' })
  expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
  expect(() => composed.prepareWorkspace('ag-missing')).toThrow(/not found/)
})

test('a symlinked persona is omitted and its path, never its contents, is logged', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  const outside = join(home, 'private')
  writeFileSync(outside, 'DO NOT READ THIS')
  const path = join(agent.folder, 'instructions.prepend.md')
  symlinkSync(outside, path)
  expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
  expect(logs).toEqual([expect.objectContaining({ kind: 'agent.instructions.omitted', path })])
  expect(JSON.stringify(logs)).not.toContain('DO NOT READ THIS')
})

test('a non-regular persona is omitted without losing trusted instructions', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  mkdirSync(join(agent.folder, 'instructions.prepend.md'))
  expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
  expect(logs).toEqual([
    expect.objectContaining({ kind: 'agent.instructions.omitted', reason: 'not_regular' }),
  ])
})

test('personas are capped at 16000 Unicode code points without splitting an emoji', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  const path = join(agent.folder, 'instructions.prepend.md')
  writeFileSync(path, '😀'.repeat(16000) + 'DROP')
  expect(composed.prepareWorkspace(agent.id)).toBe(
    'Your name is work.\n\n' + '😀'.repeat(16000) + '\n\nTrusted base',
  )
  expect(logs).toEqual([{ kind: 'agent.instructions.truncated', path, droppedBytes: 4 }])
})

test('a huge sparse persona still returns a bounded prefix and reports omitted bytes', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  const path = join(agent.folder, 'instructions.prepend.md')
  writeFileSync(path, 'p'.repeat(64004))
  truncateSync(path, 1024 * 1024 * 1024)
  expect(composed.prepareWorkspace(agent.id)).toBe(
    'Your name is work.\n\n' + 'p'.repeat(16000) + '\n\nTrusted base',
  )
  expect(logs).toEqual([{ kind: 'agent.instructions.truncated', path, droppedBytes: 1073725824 }])
})

test('persona update persists across ledger recreation without changing identity or invoking create hooks', async () => {
  const created: string[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    onCreate: (_, id) => created.push(id),
  })
  const agent = composed.create({ name: 'work' })
  const client = createRouterClient(router, {
    context: {
      db,
      agentLedger: composed,
      caller: { kind: 'host' },
      guard: () => ({ kind: 'allow' }),
      grant: null,
    },
  })
  expect(await client.update({ agentGroupId: agent.id, persona: 'Always be concise.' })).toEqual(
    agent,
  )
  expect(createAgentLedger({ db, home }).prepareWorkspace(agent.id)).toContain('Always be concise.')
  expect(created).toEqual([agent.id])
  expect(() => composed.update({ agentGroupId: 'ag-missing', persona: 'no' })).toThrow(/not found/)
  expect(() => composed.update({ agentGroupId: agent.id, persona: '😀'.repeat(16001) })).toThrow(
    /16000/,
  )
  expect(composed.prepareWorkspace(agent.id)).toContain('Always be concise.')
  composed.update({ agentGroupId: agent.id, persona: '😀'.repeat(16000) })
  expect(composed.prepareWorkspace(agent.id)).toContain('😀'.repeat(16000))
  composed.update({ agentGroupId: agent.id, persona: '' })
  expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
})

test('persona updates refuse a symlink and leave its target untouched', () => {
  const agent = ledger.create({ name: 'work' })
  const target = join(home, 'outside')
  writeFileSync(target, 'keep')
  symlinkSync(target, join(agent.folder, 'instructions.prepend.md'))
  expect(() => ledger.update({ agentGroupId: agent.id, persona: 'replace' })).toThrow()
  expect(readFileSync(target, 'utf8')).toBe('keep')
  expect(readdirSync(agent.folder)).toEqual(['instructions.prepend.md'])
})

test('a replaced workspace directory cannot redirect persona reads or writes', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'instructions.prepend.md'), 'private')
  rmSync(agent.folder, { recursive: true })
  symlinkSync(outside, agent.folder)
  expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
  expect(logs).toEqual([
    expect.objectContaining({
      kind: 'agent.instructions.omitted',
      path: join(agent.folder, 'memory/index.md'),
    }),
    expect.objectContaining({
      kind: 'agent.instructions.omitted',
      path: join(agent.folder, 'system/index.md'),
    }),
    expect.objectContaining({
      kind: 'agent.instructions.omitted',
      path: join(agent.folder, 'instructions.prepend.md'),
    }),
  ])
  expect(readdirSync(outside)).toEqual(['instructions.prepend.md'])
  expect(() => composed.update({ agentGroupId: agent.id, persona: 'replace' })).toThrow()
  expect(readFileSync(join(outside, 'instructions.prepend.md'), 'utf8')).toBe('private')
})

test('an unreadable persona is omitted with metadata-only diagnostics', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  const path = join(agent.folder, 'instructions.prepend.md')
  writeFileSync(path, 'PRIVATE PERSONA CONTENT')
  chmodSync(path, 0)
  try {
    expect(composed.prepareWorkspace(agent.id)).toBe('Your name is work.\n\nTrusted base')
    expect(logs).toEqual([{ kind: 'agent.instructions.omitted', path, reason: 'EACCES' }])
  } finally {
    chmodSync(path, 0o600)
  }
})

test('persona writes replace hard links rather than overwriting another file', () => {
  const agent = ledger.create({ name: 'work' })
  const outside = join(home, 'outside')
  const persona = join(agent.folder, 'instructions.prepend.md')
  writeFileSync(outside, 'keep')
  linkSync(outside, persona)
  ledger.update({ agentGroupId: agent.id, persona: 'new persona' })
  expect(readFileSync(outside, 'utf8')).toBe('keep')
  expect(ledger.prepareWorkspace(agent.id)).toContain('new persona')
  expect(statSync(persona).mode & 0o777).toBe(0o600)
  expect(readdirSync(agent.folder).toSorted()).toEqual([
    'instructions.prepend.md',
    'memory',
    'system',
  ])
})

test('a FIFO persona does not block composition', () => {
  const agent = ledger.create({ name: 'work' })
  const path = join(agent.folder, 'instructions.prepend.md')
  expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0)
  expect(ledger.prepareWorkspace(agent.id)).toBe('Your name is work.')
})

test('memory is scaffolded per group and keeps edits across preparations and ledger recreation', () => {
  const memoryTemplates = { memory: '# Core memory\n', system: '# Memory system\n' }
  const composed = createAgentLedger({ db, home, memoryTemplates })
  const work = composed.create({ name: 'work' })
  const other = composed.create({ name: 'other' })
  expect(composed.prepareWorkspace(work.id)).toContain('# Core memory')
  const index = join(work.folder, 'memory/index.md')
  const system = join(work.folder, 'system/index.md')
  expect(readFileSync(index, 'utf8')).toBe('# Core memory\n')
  expect(readFileSync(system, 'utf8')).toBe('# Memory system\n')
  writeFileSync(index, 'Owner prefers tea.')
  writeFileSync(system, 'Keep dates with facts.')
  const reopened = createAgentLedger({ db, home, memoryTemplates })
  const text = reopened.prepareWorkspace(work.id)
  expect(text).toContain('Owner prefers tea.')
  expect(text).toContain('Keep dates with facts.')
  expect(readFileSync(index, 'utf8')).toBe('Owner prefers tea.')
  expect(readFileSync(system, 'utf8')).toBe('Keep dates with facts.')
  expect(reopened.prepareWorkspace(other.id)).not.toContain('Owner prefers tea.')
  expect(readFileSync(join(other.folder, 'memory/index.md'), 'utf8')).toBe('# Core memory\n')
  rmSync(join(work.folder, 'memory'), { recursive: true })
  expect(reopened.prepareWorkspace(work.id)).toContain('# Core memory')
  expect(readFileSync(system, 'utf8')).toBe('Keep dates with facts.')
})

test('each memory index has its own bounded Unicode budget and content-free truncation diagnostic', () => {
  const logs: unknown[] = []
  const composed = createAgentLedger({
    db,
    home,
    baseInstructions: 'Trusted base',
    log: (entry) => logs.push(entry),
  })
  const agent = composed.create({ name: 'work' })
  composed.prepareWorkspace(agent.id)
  const memory = join(agent.folder, 'memory/index.md')
  const system = join(agent.folder, 'system/index.md')
  writeFileSync(memory, '😀'.repeat(16000) + 'PRIVATE DROPPED MEMORY')
  writeFileSync(system, 's'.repeat(64004))
  truncateSync(system, 1024 * 1024 * 1024)
  expect(composed.prepareWorkspace(agent.id)).toBe(
    'Your name is work.\n\nTrusted base\n\n### memory/index.md\n\n' +
      '😀'.repeat(16000) +
      '\n\n### system/index.md\n\n' +
      's'.repeat(16000),
  )
  expect(logs).toEqual([
    { kind: 'agent.instructions.truncated', path: memory, droppedBytes: 22 },
    { kind: 'agent.instructions.truncated', path: system, droppedBytes: 1073725824 },
  ])
  expect(readFileSync(memory, 'utf8')).toEndWith('PRIVATE DROPPED MEMORY')
})

test.each(['memory', 'system'])(
  '%s directories and indexes never follow links or overwrite their targets',
  (directory) => {
    const logs: unknown[] = []
    const composed = createAgentLedger({
      db,
      home,
      baseInstructions: 'Trusted base',
      log: (entry) => logs.push(entry),
    })
    const agent = composed.create({ name: 'work' })
    const other = composed.create({ name: 'other' })
    composed.prepareWorkspace(other.id)
    const target = join(other.folder, directory)
    const privateIndex = join(target, 'index.md')
    writeFileSync(privateIndex, 'PRIVATE OTHER GROUP')
    const dir = join(agent.folder, directory)
    const path = join(dir, 'index.md')
    symlinkSync(target, dir)
    expect(composed.prepareWorkspace(agent.id)).not.toContain('PRIVATE OTHER GROUP')
    expect(readFileSync(privateIndex, 'utf8')).toBe('PRIVATE OTHER GROUP')
    rmSync(dir)
    mkdirSync(dir)
    symlinkSync(privateIndex, path)
    expect(composed.prepareWorkspace(agent.id)).not.toContain('PRIVATE OTHER GROUP')
    expect(readFileSync(privateIndex, 'utf8')).toBe('PRIVATE OTHER GROUP')
    rmSync(path)
    const absent = join(home, 'must-not-create')
    symlinkSync(absent, path)
    composed.prepareWorkspace(agent.id)
    expect(existsSync(absent)).toBe(false)
    expect(logs).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: 'agent.instructions.omitted',
        path,
        reason: 'unreadable',
      })),
    )
    expect(readdirSync(join(home, 'groups')).toSorted()).toEqual(['other', 'work'])
  },
)

test.each(['directory', 'fifo', 'invalid_utf8', 'unreadable'])(
  'an unusable memory index (%s) is omitted without blocking other instructions',
  (kind) => {
    const logs: unknown[] = []
    const composed = createAgentLedger({
      db,
      home,
      baseInstructions: 'Trusted base',
      log: (entry) => logs.push(entry),
    })
    const agent = composed.create({ name: 'work' })
    composed.prepareWorkspace(agent.id)
    const path = join(agent.folder, 'memory/index.md')
    const system = join(agent.folder, 'system/index.md')
    writeFileSync(system, 'Keep this memory guidance.')
    rmSync(path)
    if (kind === 'directory') mkdirSync(path)
    if (kind === 'fifo') expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0)
    if (kind === 'invalid_utf8') writeFileSync(path, Buffer.from([0xff]))
    if (kind === 'unreadable') {
      writeFileSync(path, 'PRIVATE UNREADABLE MEMORY')
      chmodSync(path, 0)
    }
    try {
      expect(composed.prepareWorkspace(agent.id)).toBe(
        'Your name is work.\n\nTrusted base\n\n### system/index.md\n\nKeep this memory guidance.',
      )
      expect(logs).toEqual([
        {
          kind: 'agent.instructions.omitted',
          path,
          reason:
            kind === 'directory' || kind === 'fifo'
              ? 'not_regular'
              : kind === 'invalid_utf8'
                ? 'ERR_ENCODING_INVALID_ENCODED_DATA'
                : 'unreadable',
        },
      ])
    } finally {
      if (kind === 'unreadable') chmodSync(path, 0o600)
    }
  },
)

test('scaffolding leaves hard-linked memory files and missing system directories independent', () => {
  const composed = createAgentLedger({
    db,
    home,
    memoryTemplates: { memory: 'Seed facts', system: 'Seed guidance' },
  })
  const agent = composed.create({ name: 'work' })
  composed.prepareWorkspace(agent.id)
  const index = join(agent.folder, 'memory/index.md')
  rmSync(index)
  const target = join(home, 'host-file')
  writeFileSync(target, 'Keep this file')
  linkSync(target, index)
  rmSync(join(agent.folder, 'system'), { recursive: true })
  const text = composed.prepareWorkspace(agent.id)
  expect(text).toContain('Keep this file')
  expect(text).toContain('Seed guidance')
  expect(readFileSync(target, 'utf8')).toBe('Keep this file')
  expect(statSync(join(agent.folder, 'system/index.md')).mode & 0o777).toBe(0o600)
  expect(statSync(join(agent.folder, 'system')).mode & 0o777).toBe(0o700)
})
