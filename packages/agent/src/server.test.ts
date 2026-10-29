import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
