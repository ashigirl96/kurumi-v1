import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createRouterClient, ORPCError, os } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { z } from 'zod'

import type { Meta } from './contract.ts'
import { guardRouter, transaction, type KurumiContext } from './server.ts'

const sqlite = new Database(':memory:')
const db = drizzle(sqlite)
const base = os.$context<KurumiContext>().$meta<Meta>({})
const context: KurumiContext = {
  db,
  caller: { kind: 'agent', agentGroupId: 'ag-test', sessionId: 'session-test' },
  guard: () => ({ kind: 'allow' }),
  grant: null,
}

afterAll(() => {
  sqlite.close()
})

afterEach(() => {
  sqlite.run('DROP TABLE IF EXISTS transaction_probe')
})

test('an agent cannot reach an unmarked nested procedure even when the injected guard allows it', async () => {
  let handled = false
  let guarded = false
  const router = guardRouter<KurumiContext>().router({
    nested: {
      secret: base.handler(() => {
        handled = true
      }),
    },
  })
  const client = createRouterClient(router, {
    context: {
      ...context,
      guard: () => {
        guarded = true
        return { kind: 'allow' }
      },
    },
  })

  const error = await client.nested.secret().catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 })
  expect(handled).toBe(false)
  expect(guarded).toBe(false)
})

test('oRPC rejects HTTP 202 as an error status', () => {
  expect(() => new ORPCError('APPROVAL_PENDING', { status: 202 })).toThrow(
    'Invalid error status code',
  )
})

test('a held call returns APPROVAL_PENDING with HTTP status 409 and the approval id', async () => {
  let handled = false
  const router = guardRouter<KurumiContext>().router({
    action: base.meta({ agent: 'hold' }).handler(() => {
      handled = true
    }),
  })
  const client = createRouterClient(router, {
    context: { ...context, guard: () => ({ kind: 'held', approvalId: 'approval-test' }) },
  })

  const error = await client.action().catch((caught: unknown) => caught)
  expect(error).toMatchObject({
    code: 'APPROVAL_PENDING',
    status: 409,
    data: { approvalId: 'approval-test' },
  })
  expect(handled).toBe(false)
})

test('a denied call preserves the guard reason and an allowed call reaches its handler', async () => {
  const router = guardRouter<KurumiContext>().router({
    action: base.meta({ agent: 'channel' }).handler(() => 'received'),
  })
  const denied = createRouterClient(router, {
    context: { ...context, guard: () => ({ kind: 'deny', reason: 'outside your group' }) },
  })
  const error = await denied.action().catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'outside your group' })
  expect(await createRouterClient(router, { context }).action()).toBe('received')
})

test('the transaction helper returns synchronous values and rolls back failed writes', () => {
  sqlite.run('CREATE TABLE transaction_probe (value TEXT)')
  expect(
    transaction(db, (tx) => {
      tx.run("INSERT INTO transaction_probe VALUES ('kept')")
      return 7
    }),
  ).toBe(7)
  expect(() =>
    transaction(db, (tx) => {
      tx.run("INSERT INTO transaction_probe VALUES ('rolled back')")
      throw new Error('stop')
    }),
  ).toThrow('stop')
  expect(sqlite.query('SELECT value FROM transaction_probe').all()).toEqual([{ value: 'kept' }])
})

test('the final lint configuration rejects voided Promises and the three sync-transaction shapes', async () => {
  const repo = resolve(import.meta.dir, '../../..')
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-transaction-lint-'))
  try {
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
    mkdirSync(join(dir, 'scripts/oxlint'), { recursive: true })
    copyFileSync(join(repo, '.oxlintrc.json'), join(dir, '.oxlintrc.json'))
    copyFileSync(join(repo, 'scripts/oxlint/kurumi.js'), join(dir, 'scripts/oxlint/kurumi.js'))
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    )
    writeFileSync(
      join(dir, 'probe.ts'),
      `
      declare const db: { transaction<T>(callback: (tx: unknown) => T): T }
      declare function write(tx: unknown): Promise<void>
      db.transaction((tx) => { void write(tx) })
    `,
    )
    const rejected = {
      'inline.ts': 'db.transaction(async (tx) => tx)',
      'named.ts': 'async function write(tx: unknown) { return tx }; db.transaction(write)',
      'expression.ts':
        'async function write(tx: unknown) { return tx }; db.transaction((tx) => write(tx))',
    }
    for (const [file, source] of Object.entries(rejected)) {
      writeFileSync(
        join(dir, file),
        `export {}; declare const db: { transaction<T>(callback: (tx: unknown) => T): T }; ${source}`,
      )
    }
    const result = Bun.spawn(
      [join(repo, 'node_modules/.bin/oxlint'), '-f', 'json', 'probe.ts', ...Object.keys(rejected)],
      {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const report = z
      .object({ diagnostics: z.array(z.object({ filename: z.string(), code: z.string() })) })
      .parse(await new Response(result.stdout).json())
    await result.exited
    expect(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.filename === 'probe.ts' && diagnostic.code.includes('no-floating-promises'),
      ),
    ).toBe(true)
    expect(
      report.diagnostics
        .filter((diagnostic) => diagnostic.code.includes('sync-transaction'))
        .map((diagnostic) => diagnostic.filename)
        .toSorted(),
    ).toEqual(Object.keys(rejected).toSorted())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('TypeScript rejects Promise returns through inline, imported, block, function and chained callbacks', async () => {
  const repo = resolve(import.meta.dir, '../../..')
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-transaction-types-'))
  try {
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
    writeFileSync(join(dir, 'helper.ts'), 'export async function write() { return 1 }')
    const prelude = `
      import { transaction, type Db } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))}
      import { write } from './helper.ts'
      declare const db: Db
    `
    writeFileSync(
      join(dir, 'valid.ts'),
      `${prelude}
      const count: number = transaction(db, () => 7)
      transaction(db, () => {})
    `,
    )
    const rejected = {
      'inline.ts': 'transaction(db, async () => 1)',
      'block.ts': 'transaction(db, () => { return write() })',
      'function.ts': 'transaction(db, function () { return write() })',
      'imported.ts': 'transaction(db, write)',
      'chain.ts': 'transaction(db, () => write().then(value => value))',
      'method.ts': 'const ledger = { write }; transaction(db, () => ledger.write())',
      'union.ts': 'transaction(db, () => Math.random() > 0.5 ? 1 : write())',
    }
    for (const [file, source] of Object.entries(rejected)) {
      writeFileSync(join(dir, file), `${prelude}\n${source}`)
    }
    const result = Bun.spawn(
      [
        join(repo, 'node_modules/.bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ESNext',
        '--module',
        'ESNext',
        '--moduleResolution',
        'bundler',
        '--allowImportingTsExtensions',
        join(dir, 'valid.ts'),
        ...Object.keys(rejected).map((file) => join(dir, file)),
      ],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
    )
    const output = await new Response(result.stdout).text()
    const errors = await new Response(result.stderr).text()
    expect({ code: await result.exited, output, errors }).toMatchObject({ code: 1 })
    expect(errors).toBe('')
    const diagnostics = [...output.matchAll(/([^/\n]+\.ts)\(\d+,\d+\): error TS(\d+):/g)]
    expect(diagnostics.map((match) => match[1]).toSorted()).toEqual(
      Object.keys(rejected).toSorted(),
    )
    expect(diagnostics.every((match) => match[2] === '2345' || match[2] === '2322')).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
