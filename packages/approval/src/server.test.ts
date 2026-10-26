import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { user } from '@kurumi/access/schema'
import {
  createAccessLedger,
  migrations as accessMigrations,
  router as accessRouter,
  type AccessLedger,
} from '@kurumi/access/server'
import { migrations as agentMigrations } from '@kurumi/agent/server'
import type { Caller, Meta } from '@kurumi/rpc/contract'
import {
  callByPath,
  guardRouter,
  transaction,
  type ApprovalGrant,
  type Db,
  type KurumiContext,
} from '@kurumi/rpc/server'
import { createRouterClient, os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { z } from 'zod'

import { pendingApproval } from './schema.ts'
import {
  createApprovalLedger,
  migrations,
  router as approvalRouter,
  type ApprovalDecision,
  type ApprovalHandlers,
  type ApprovalLedger,
  type ApprovalLog,
  type ApprovalRecord,
} from './server.ts'

const agent = { kind: 'agent', agentGroupId: 'ag-a', sessionId: 'session-a' } as const
const host: Caller = { kind: 'host' }
const hostApprover = { kind: 'host' } as const

let home: string
const open: Database[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kurumi-approval-'))
})

afterEach(() => {
  for (const sqlite of open.splice(0)) sqlite.close()
  rmSync(home, { recursive: true, force: true })
})

function openDb(): Db {
  const sqlite = new Database(join(home, 'kurumi.db'))
  open.push(sqlite)
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const { folder, table } of [agentMigrations, accessMigrations, migrations]) {
    migrate(db, { migrationsFolder: folder, migrationsTable: table })
  }
  db.run(
    sql`INSERT OR IGNORE INTO agent_group (id, name, folder, created_at) VALUES ('ag-a', 'a', 'a', 0)`,
  )
  return db
}

type Handled = { id: string; decision: ApprovalDecision }

const crash = (message: string) => () => Promise.reject(new Error(message))

function recordingLedger(db: Db, run: () => Promise<void> = () => Promise.resolve()) {
  const handled: Handled[] = []
  const logged: ApprovalLog[] = []
  const record = (approval: ApprovalRecord, decision: ApprovalDecision) => {
    handled.push({ id: approval.id, decision })
    return run()
  }
  const accessLedger = createAccessLedger({ db })
  const ledger = createApprovalLedger({
    db,
    accessLedger,
    handlers: () => ({ procedure: record, 'gateway.request': record }),
    decidePath: ['approval', 'decide'],
    log: (event) => logged.push(event),
  })
  return { ledger, accessLedger, handled, logged }
}

function requestProcedure(db: Db, ledger: ApprovalLedger): string {
  return transaction(
    db,
    (tx) =>
      ledger.request(tx, {
        kind: 'procedure',
        agentGroupId: agent.agentGroupId,
        sessionId: agent.sessionId,
        title: 'access.users.create',
        body: ['Agent asks to create slack:U1'],
        payload: { path: ['access', 'users', 'create'], input: {}, caller: agent },
      }).approvalId,
  )
}

function grantAdmin(db: Db, userId: string, agentGroupId: string) {
  db.run(
    sql`INSERT OR IGNORE INTO user (id, kind, display_name) VALUES (${userId}, 'slack', ${userId})`,
  )
  db.run(
    sql`INSERT INTO user_role (user_id, role, agent_group_id, granted_by, granted_at) VALUES (${userId}, 'admin', ${agentGroupId}, 'host', 0)`,
  )
}

test('a request stores a pending approval with the approver chain baked in', () => {
  const db = openDb()
  grantAdmin(db, 'slack:admin', 'ag-a')
  const { ledger } = recordingLedger(db)

  const id = requestProcedure(db, ledger)

  expect(id).toMatch(/^apr-[0-9a-f-]{36}$/)
  expect(ledger.show(id)).toMatchObject({
    id,
    kind: 'procedure',
    status: 'pending',
    agentGroupId: 'ag-a',
    sessionId: 'session-a',
    title: 'access.users.create',
    approvers: [{ kind: 'user', userId: 'slack:admin' }, hostApprover],
  })
  expect(ledger.list('pending').map((approval) => approval.id)).toEqual([id])
  expect(ledger.list('decided')).toEqual([])
})

test.each([
  ['approve', 'approved'],
  ['deny', 'denied'],
] as const)(
  '%s decides once, runs the handler, and records it as handled',
  async (decision, status) => {
    const db = openDb()
    const { ledger, handled } = recordingLedger(db)
    const id = requestProcedure(db, ledger)

    const result = await ledger.decide({ id, decision, by: host })

    expect(result).toMatchObject({ changed: true, approval: { status, decidedBy: hostApprover } })
    expect(result.message).toStartWith(`${status} by host at `)
    expect(handled).toEqual([{ id, decision }])
    expect(ledger.show(id)).toMatchObject({ status, handledAt: expect.any(Date) })
    expect(ledger.list('decided').map((approval) => approval.id)).toEqual([id])
  },
)

test('a second decision changes nothing, says who decided, and does not rerun the handler', async () => {
  const db = openDb()
  const { ledger, handled } = recordingLedger(db)
  const id = requestProcedure(db, ledger)
  await ledger.decide({ id, decision: 'approve', by: host })
  const first = ledger.show(id)

  const second = await ledger.decide({ id, decision: 'deny', by: host })

  expect(second.changed).toBe(false)
  expect(second.message).toMatch(/^already approved by host at \d{4}-/)
  expect(second.approval).toEqual(first)
  expect(handled).toHaveLength(1)
})

test('deciding a missing approval is NOT_FOUND', async () => {
  const { ledger } = recordingLedger(openDb())
  expect(
    await ledger
      .decide({ id: 'apr-missing', decision: 'approve', by: host })
      .catch((caught: unknown) => caught),
  ).toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('an approval requested before a restart is decided after it, running the handler once', async () => {
  const before = openDb()
  const id = requestProcedure(before, recordingLedger(before).ledger)
  for (const sqlite of open.splice(0)) sqlite.close()

  const after = openDb()
  const { ledger, handled } = recordingLedger(after)
  await ledger.start()
  expect(handled).toEqual([])
  await ledger.decide({ id, decision: 'approve', by: host })

  expect(handled).toEqual([{ id, decision: 'approve' }])
})

test('the approvers are frozen when the approval is requested', async () => {
  const db = openDb()
  grantAdmin(db, 'slack:original', 'ag-a')
  const { ledger } = recordingLedger(db)
  const first = requestProcedure(db, ledger)
  const second = requestProcedure(db, ledger)
  db.run(sql`DELETE FROM user_role WHERE user_id = 'slack:original'`)
  grantAdmin(db, 'slack:newcomer', 'ag-a')

  expect(
    await ledger
      .decide({
        id: first,
        decision: 'approve',
        by: { kind: 'human', userId: 'slack:newcomer' },
      })
      .catch((caught: unknown) => caught),
  ).toMatchObject({ code: 'FORBIDDEN' })
  expect(ledger.show(first).status).toBe('pending')
  expect(
    await ledger.decide({
      id: first,
      decision: 'approve',
      by: { kind: 'human', userId: 'slack:original' },
    }),
  ).toMatchObject({
    changed: true,
    approval: { decidedBy: { kind: 'user', userId: 'slack:original' } },
  })
  expect(await ledger.decide({ id: second, decision: 'deny', by: host })).toMatchObject({
    changed: true,
    approval: { decidedBy: hostApprover },
  })
})

test('start reruns, exactly once, a decided approval whose host died before its handler finished', async () => {
  const db = openDb()
  const id = requestProcedure(db, recordingLedger(db).ledger)
  db.update(pendingApproval)
    .set({ status: 'approved', decidedBy: hostApprover, decidedAt: new Date() })
    .where(eq(pendingApproval.id, id))
    .run()

  const { ledger, handled } = recordingLedger(db)
  await ledger.start()
  await ledger.start()

  expect(handled).toEqual([{ id, decision: 'approve' }])
  expect(ledger.show(id)).toMatchObject({ handledAt: expect.any(Date), handlerError: null })
})

test('a handler that throws runs once, is recorded as failed, and is not rerun at start', async () => {
  const db = openDb()
  const crashing = recordingLedger(db, crash('handler crashed'))
  const id = requestProcedure(db, crashing.ledger)

  const decided = await crashing.ledger.decide({ id, decision: 'approve', by: host })

  expect(decided.changed).toBe(true)
  expect(decided.message).toMatch(
    /^approved by host at .*, but its handler failed: handler crashed$/,
  )
  expect(decided.approval).toMatchObject({
    status: 'approved',
    handledAt: expect.any(Date),
    handlerError: 'handler crashed',
  })
  expect(crashing.ledger.list('decided')).toMatchObject([{ id, handlerError: 'handler crashed' }])

  const restarted = recordingLedger(db)
  await restarted.ledger.start()
  expect(restarted.handled).toEqual([])
  expect(crashing.handled).toHaveLength(1)
})

test('the table refuses a half-decided row, a handled pending row, and unknown values', () => {
  const db = openDb()
  const id = requestProcedure(db, recordingLedger(db).ledger)
  const now = Date.now()
  const sqlite = new Database(join(home, 'kurumi.db'))
  open.push(sqlite)
  const illegal = [
    `status = 'approved'`,
    `status = 'approved', decided_by = 'host'`,
    `status = 'approved', decided_at = ${now}`,
    `decided_by = 'host'`,
    `decided_at = ${now}`,
    `handled_at = ${now}`,
    `status = 'bogus', decided_by = 'host', decided_at = ${now}`,
    `kind = 'bogus'`,
    `status = 'denied', decided_by = 'host', decided_at = ${now}, handler_error = 'x'`,
  ]
  for (const set of illegal) {
    expect(() => sqlite.run(`UPDATE pending_approval SET ${set} WHERE id = '${id}'`)).toThrow(
      'CHECK constraint failed',
    )
  }
  expect(ledgerRow(db, id).status).toBe('pending')
  expect(ledgerRow(db, id).decidedBy).toBeNull()
})

type Context = KurumiContext & { accessLedger: AccessLedger; approvalLedger: ApprovalLedger }
const probe = os.$context<Context>().$meta<Meta>({})
const heldProbe = probe.meta({ agent: 'hold' })

function composedHost(db: Db) {
  const accessLedger: AccessLedger = createAccessLedger({ db })
  const logged: ApprovalLog[] = []
  const approvalLedger = createApprovalLedger({
    db,
    accessLedger,
    handlers: () => handlers,
    decidePath: ['approval', 'decide'],
    log: (event) => logged.push(event),
  })
  const ran: unknown[] = []
  const router = guardRouter<Context>().router({
    access: accessRouter,
    approval: approvalRouter,
    probe: {
      tagged: heldProbe
        .input(z.object({ tags: z.string().transform((tags) => tags.split(',')) }))
        .handler(({ input }) => {
          ran.push(input.tags)
        }),
      note: heldProbe.input(z.object({ text: z.string() })).handler(() => {}),
      scoped: probe
        .meta({ agent: 'scoped' })
        .input(z.object({ name: z.string() }))
        .handler(() => {}),
    },
  })
  const contextFor = (caller: Caller, grant: ApprovalGrant | null = null): Context => ({
    db,
    caller,
    guard: approvalLedger.guard,
    grant,
    accessLedger,
    approvalLedger,
  })
  const handlers: ApprovalHandlers = {
    async procedure(approval, decision) {
      if (decision === 'deny') return
      const { path, input, caller } = approval.payload
      await callByPath(router, path, input, contextFor(caller, { approvalId: approval.id }))
    },
    'gateway.request': () => Promise.reject(new Error('no gateway approvals yet')),
  }
  const post = async (caller: Caller, path: string, json: unknown) => {
    const { response } = await new RPCHandler(router).handle(
      new Request(`http://agent.invalid/rpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json }),
      }),
      { prefix: '/rpc', context: contextFor(caller) },
    )
    const body = z
      .object({ json: z.object({ code: z.string(), data: z.unknown() }).partial() })
      .parse(await response?.json())
    return { status: response?.status, ...body.json }
  }
  const held = async (caller: Caller, path: string, json: unknown): Promise<string> => {
    const answer = await post(caller, path, json)
    const { approvalId } = z.object({ approvalId: z.string() }).parse(answer.data)
    return approvalId
  }
  return { router, contextFor, post, held, ran, logged }
}

test('an agent-held users.create runs only after the host approves it, and only once', async () => {
  const db = openDb()
  const { router, contextFor } = composedHost(db)

  const held = await new RPCHandler(router).handle(
    new Request('http://agent.invalid/rpc/access/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ json: { id: 'slack:U1', displayName: 'Bob' } }),
    }),
    { prefix: '/rpc', context: contextFor(agent) },
  )
  expect(held.response?.status).toBe(409)
  const body: unknown = await held.response?.json()
  expect(body).toMatchObject({
    json: { code: 'APPROVAL_PENDING', status: 409, data: { approvalId: expect.any(String) } },
  })
  const [approval] = db.select().from(pendingApproval).all()
  if (approval === undefined) throw new Error('the held call left no approval')
  expect(body).toMatchObject({ json: { data: { approvalId: approval.id } } })
  expect(db.select().from(user).all()).toEqual([])

  const hostClient = createRouterClient(router, { context: contextFor(host) })
  const decided = await hostClient.approval.decide([approval.id, { approve: true }])

  expect(decided).toMatchObject({ changed: true, approval: { status: 'approved' } })
  expect(db.select().from(user).all()).toEqual([
    { id: 'slack:U1', kind: 'slack', displayName: 'Bob' },
  ])
  const handledAt = ledgerRow(db, approval.id).handledAt
  expect(handledAt).toBeInstanceOf(Date)

  const again = await hostClient.approval.decide([approval.id, { approve: true }])
  expect(again.changed).toBe(false)
  expect(db.select().from(user).all()).toHaveLength(1)
  expect(ledgerRow(db, approval.id).handledAt).toEqual(handledAt)

  const replayed = createRouterClient(router, {
    context: contextFor(agent, { approvalId: approval.id }),
  })
  expect(
    await replayed.access.users
      .create({ id: 'slack:U2', displayName: 'Eve' })
      .catch((caught: unknown) => caught),
  ).toMatchObject({ code: 'FORBIDDEN' })
})

test('an approve or deny flag is required, but not both', async () => {
  const { router, contextFor } = composedHost(openDb())
  const hostClient = createRouterClient(router, { context: contextFor(host) })
  for (const flags of [{}, { approve: true, deny: true }]) {
    expect(
      await hostClient.approval.decide(['apr-missing', flags]).catch((caught: unknown) => caught),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

test('a grant is refused for another input or another caller', async () => {
  const db = openDb()
  const { router, contextFor, held } = composedHost(db)
  const input = { id: 'slack:U1', displayName: 'Bob' }
  const id = await held(agent, 'access/users/create', input)
  db.update(pendingApproval)
    .set({ status: 'approved', decidedBy: hostApprover, decidedAt: new Date() })
    .where(eq(pendingApproval.id, id))
    .run()
  const replay = (caller: Caller) =>
    createRouterClient(router, { context: contextFor(caller, { approvalId: id }) }).access.users

  const other = { kind: 'agent', agentGroupId: 'ag-a', sessionId: 'session-b' } as const
  for (const attempt of [
    () => replay(agent).create({ id: 'slack:U9', displayName: 'Eve' }),
    () => replay(other).create(input),
  ]) {
    expect(await attempt().catch((caught: unknown) => caught)).toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(db.select().from(user).all()).toEqual([])
  expect(await replay(agent).create(input)).toMatchObject({ id: 'slack:U1' })
})

test('an oversized held input is refused before any approval is written', async () => {
  const db = openDb()
  const { post } = composedHost(db)

  const longId = await post(agent, 'access/users/create', {
    id: `slack:${'A'.repeat(5_000_000)}`,
    displayName: 'x',
  })
  const longNote = await post(agent, 'probe/note', { text: 'A'.repeat(100_000) })

  expect(longId).toMatchObject({ status: 400, code: 'BAD_REQUEST' })
  expect(longNote).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
  expect(db.select().from(pendingApproval).all()).toEqual([])
})

test('the same held call from the same caller reuses its pending approval', async () => {
  const db = openDb()
  const { router, contextFor, held } = composedHost(db)
  const input = { id: 'slack:U1', displayName: 'Bob' }

  const first = await held(agent, 'access/users/create', input)
  const repeats = await Promise.all(
    Array.from({ length: 5 }, () => held(agent, 'access/users/create', input)),
  )
  const otherInput = await held(agent, 'access/users/create', { ...input, displayName: 'Eve' })
  const otherSession = await held(
    { ...agent, sessionId: 'session-b' },
    'access/users/create',
    input,
  )

  expect(new Set(repeats)).toEqual(new Set([first]))
  expect(new Set([first, otherInput, otherSession]).size).toBe(3)
  await createRouterClient(router, { context: contextFor(host) }).approval.decide([
    first,
    { deny: true },
  ])
  expect(await held(agent, 'access/users/create', input)).not.toBe(first)
})

const invisible = '\u202e\u2028\u3164\ufe0f\u{e0100}\u0085\u200b'
const escaped = '\\u{202e}\\u{2028}\\u{3164}\\u{fe0f}\\u{e0100}\\u{85}\\u{200b}'
const unprintable = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const cliMain = resolve(import.meta.dir, '../../../apps/cli/src/main.ts')

async function kurumi(...argv: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, cliMain, ...argv], {
    env: { ...process.env, KURUMI_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ argv, exitCode, stderr }).toEqual({ argv, exitCode: 0, stderr: '' })
  return stdout
}

test('invisible code points are escaped in the stored title, body, and handler error, and in what the CLI prints', async () => {
  const db = openDb()
  const { router, contextFor, held } = composedHost(db)
  const heldId = await held(agent, 'access/users/create', {
    id: 'slack:U1',
    displayName: `Bob${invisible}approved by host`,
  })
  const { ledger } = recordingLedger(db, crash(`boom${invisible}`))
  const requested = transaction(
    db,
    (tx) =>
      ledger.request(tx, {
        kind: 'gateway.request',
        agentGroupId: null,
        sessionId: null,
        title: `title${invisible}`,
        body: [`body${invisible}`],
        payload: { url: 'https://example.com' },
      }).approvalId,
  )
  await ledger.decide({ id: requested, decision: 'deny', by: host })

  expect(ledger.show(requested)).toMatchObject({
    title: `title${escaped}`,
    body: [`body${escaped}`],
    handlerError: `boom${escaped}`,
  })
  expect(ledger.show(heldId).body.join('\n')).toContain(`Bob${escaped}approved by host`)

  const server = Bun.serve({
    unix: join(home, 'kurumi.sock'),
    async fetch(request) {
      const { response } = await new RPCHandler(router).handle(request, {
        prefix: '/rpc',
        context: contextFor(host),
      })
      return response ?? new Response('Not found', { status: 404 })
    },
  })
  try {
    const printed = await Promise.all([
      kurumi('approval', 'list'),
      kurumi('approval', 'list', '--status', 'decided'),
      kurumi('approval', 'show', heldId),
      kurumi('approval', 'show', requested),
    ])
    expect(printed.join('').replaceAll('\n', '')).not.toMatch(unprintable)
    expect(printed[0]).toContain(`Bob${escaped.replaceAll('\\', '\\\\')}approved by host`)
    expect(printed[3]).toContain(`boom${escaped.replaceAll('\\', '\\\\')}`)
  } finally {
    await server.stop(true)
  }
})

test.each([
  ['slack:admin', 'slack:admin'],
  ['slack:admin\n\u001b[31m\u0000', 'slack:admin\\u{a}\\u{1b}[31m\\u{0}'],
])('approval output escapes stored principal ids: %j', async (userId, displayedId) => {
  const db = openDb()
  grantAdmin(db, userId, 'ag-a')
  const { router, contextFor } = composedHost(db)
  const { ledger } = recordingLedger(db)
  const id = requestProcedure(db, ledger)
  const server = Bun.serve({
    unix: join(home, 'kurumi.sock'),
    async fetch(request) {
      const caller: Caller = new URL(request.url).pathname.endsWith('/decide')
        ? { kind: 'human', userId }
        : host
      const { response } = await new RPCHandler(router).handle(request, {
        prefix: '/rpc',
        context: contextFor(caller),
      })
      return response ?? new Response('Not found', { status: 404 })
    },
  })
  try {
    const pending = JSON.parse(await kurumi('approval', 'list'))
    const shown = JSON.parse(await kurumi('approval', 'show', id))
    const decided = JSON.parse(await kurumi('approval', 'decide', id, '--deny'))
    const repeated = JSON.parse(await kurumi('approval', 'decide', id, '--approve'))
    const listed = JSON.parse(await kurumi('approval', 'list', '--status', 'decided'))
    const settled = JSON.parse(await kurumi('approval', 'show', id))
    expect(pending[0].approvers[0]).toEqual({ kind: 'user', userId })
    expect(shown.approvers[0]).toEqual({ kind: 'user', userId })
    for (const approval of [decided.approval, repeated.approval, listed[0], settled]) {
      expect(approval.decidedBy).toEqual({ kind: 'user', userId })
    }
    expect(decided.message).toBe(`denied by user ${displayedId} at ${settled.decidedAt}`)
    expect(repeated.message).toBe(`already denied by user ${displayedId} at ${settled.decidedAt}`)
  } finally {
    await server.stop(true)
  }
})

test('approval refusal escapes a stored principal id', async () => {
  const db = openDb()
  const { ledger } = recordingLedger(db)
  const id = requestProcedure(db, ledger)
  const userId = 'slack:admin\n\u001b[31m\u0000'
  grantAdmin(db, userId, 'ag-a')

  expect(
    await ledger
      .decide({ id, decision: 'deny', by: { kind: 'human', userId } })
      .catch((caught: unknown) => caught),
  ).toMatchObject({
    code: 'FORBIDDEN',
    message: `user slack:admin\\u{a}\\u{1b}[31m\\u{0} is not an approver of ${id}`,
  })
})

test('humans named as approvers at request time decide through the router, others do not', async () => {
  const db = openDb()
  grantAdmin(db, 'slack:scoped', 'ag-a')
  db.run(sql`INSERT INTO user (id, kind, display_name) VALUES ('slack:owner', 'slack', 'o')`)
  db.run(
    sql`INSERT INTO user_role (user_id, role, agent_group_id, granted_by, granted_at) VALUES ('slack:owner', 'owner', NULL, 'host', 0)`,
  )
  const { router, contextFor, held } = composedHost(db)
  const scopedFirst = await held(agent, 'access/users/create', { id: 'slack:U1', displayName: 'a' })
  const ownerFirst = await held(agent, 'access/users/create', { id: 'slack:U2', displayName: 'b' })
  db.run(sql`DELETE FROM user_role WHERE user_id = 'slack:owner'`)
  grantAdmin(db, 'slack:newcomer', 'ag-a')
  const decide = (caller: Caller, id: string) =>
    createRouterClient(router, { context: contextFor(caller) })
      .approval.decide([id, { approve: true }])
      .catch((caught: unknown) => caught)

  expect(await decide({ kind: 'human', userId: 'slack:newcomer' }, scopedFirst)).toMatchObject({
    code: 'FORBIDDEN',
  })
  expect(await decide(agent, scopedFirst)).toMatchObject({ code: 'FORBIDDEN' })
  expect(await decide({ kind: 'human', userId: 'slack:scoped' }, scopedFirst)).toMatchObject({
    changed: true,
    approval: { decidedBy: { kind: 'user', userId: 'slack:scoped' } },
  })
  expect(await decide({ kind: 'human', userId: 'slack:owner' }, ownerFirst)).toMatchObject({
    changed: true,
    approval: { decidedBy: { kind: 'user', userId: 'slack:owner' } },
  })
  expect(db.select().from(user).where(eq(user.id, 'slack:U2')).get()).toBeDefined()
})

test('an approved call replays the input the caller sent, so a transforming schema runs once', async () => {
  const db = openDb()
  const { router, contextFor, held, ran } = composedHost(db)
  const id = await held(agent, 'probe/tagged', { tags: 'a,b' })

  const decided = await createRouterClient(router, { context: contextFor(host) }).approval.decide([
    id,
    { approve: true },
  ])

  expect(decided.message).not.toContain('failed')
  expect(ran).toEqual([['a', 'b']])
  expect(ledgerRow(db, id).payload).toMatchObject({ input: { tags: 'a,b' } })
})

function ledgerRow(db: Db, id: string) {
  const row = db.select().from(pendingApproval).where(eq(pendingApproval.id, id)).get()
  if (row === undefined) throw new Error(`approval ${id} is missing`)
  return row
}

const create = (n: number) => ({ id: `slack:U${n}`, displayName: 'Bob' })

function decideBehindTheLedger(db: Db, id: string) {
  db.run(
    sql`UPDATE pending_approval SET status = 'approved', decided_by = '{"kind":"host"}', decided_at = 0 WHERE id = ${id}`,
  )
}

test('held calls that differ only in ignored keys, key order, or untrimmed strings share one pending approval', async () => {
  const db = openDb()
  const { held } = composedHost(db)
  const first = await held(agent, 'access/users/create', { id: 'slack:U1', displayName: 'Bob' })

  for (const variant of [
    { id: 'slack:U1', displayName: 'Bob', junk: 'x'.repeat(60_000) },
    { id: 'slack:U1', displayName: 'Bob', other: 'y' },
    { displayName: 'Bob', id: 'slack:U1' },
    { id: 'slack:U1', displayName: ' Bob ' },
  ]) {
    expect(await held(agent, 'access/users/create', variant)).toBe(first)
  }
  expect(db.select().from(pendingApproval).all()).toHaveLength(1)
  expect(ledgerRow(db, first).payload).toEqual({
    path: ['access', 'users', 'create'],
    input: { id: 'slack:U1', displayName: 'Bob' },
    caller: agent,
  })
})

test('an agent group with 20 pending held calls is refused another with 429 and no row, while other kinds still request', async () => {
  const db = openDb()
  const { post, held } = composedHost(db)
  const { ledger } = recordingLedger(db)
  const requestGateway = () =>
    transaction(
      db,
      (tx) =>
        ledger.request(tx, {
          kind: 'gateway.request',
          agentGroupId: 'ag-a',
          sessionId: 'session-a',
          title: 'gateway',
          body: [],
          payload: { url: 'https://example.com' },
        }).approvalId,
    )
  requestGateway()
  const pending: string[] = []
  for (let n = 0; n < 20; n++) pending.push(await held(agent, 'access/users/create', create(n)))

  expect(await post(agent, 'access/users/create', create(20))).toMatchObject({
    status: 429,
    code: 'TOO_MANY_REQUESTS',
  })
  expect(
    await post({ ...agent, sessionId: 'session-b' }, 'access/users/create', create(21)),
  ).toMatchObject({ status: 429 })
  expect(await held(agent, 'access/users/create', create(0))).toBe(pending.at(0) ?? 'none')
  const otherGroup = { kind: 'agent', agentGroupId: 'ag-b', sessionId: 'session-b' } as const
  expect(await held(otherGroup, 'access/users/create', create(20))).toMatch(/^apr-/)
  expect(requestGateway()).toMatch(/^apr-/)
  expect(
    db.select().from(pendingApproval).where(eq(pendingApproval.agentGroupId, 'ag-a')).all(),
  ).toHaveLength(22)
})

test('a decided row whose payload does not parse is recorded as a failed handler, and start still settles the rest', async () => {
  const db = openDb()
  const { ledger: requester } = recordingLedger(db)
  const shapeless = requestProcedure(db, requester)
  const unparsable = requestProcedure(db, requester)
  const healthy = requestProcedure(db, requester)
  for (const id of [shapeless, unparsable, healthy]) decideBehindTheLedger(db, id)
  db.run(sql`UPDATE pending_approval SET payload = '{"nope":1}' WHERE id = ${shapeless}`)
  db.run(sql`UPDATE pending_approval SET payload = 'not json' WHERE id = ${unparsable}`)
  const { ledger, handled, logged } = recordingLedger(db)

  await ledger.start()

  const outcome = (id: string) =>
    db
      .select({ handledAt: pendingApproval.handledAt, handlerError: pendingApproval.handlerError })
      .from(pendingApproval)
      .where(eq(pendingApproval.id, id))
      .get()
  expect(handled).toEqual([{ id: healthy, decision: 'approve' }])
  for (const id of [shapeless, unparsable]) {
    expect(outcome(id)).toEqual({ handledAt: expect.any(Date), handlerError: expect.any(String) })
  }
  expect(outcome(healthy)).toEqual({ handledAt: expect.any(Date), handlerError: null })
  expect(logged.map((event) => [event.kind, event.approvalId])).toEqual([
    ['approval.handler.failed', shapeless],
    ['approval.handler.failed', unparsable],
  ])
})

test.each([
  ['a null-prototype object', () => Object.create(null) as unknown, 'an error with no text'],
  [
    'an error whose message is a number',
    () => Object.defineProperty(new Error('replaced'), 'message', { value: 42 }),
    '42',
  ],
])(
  'a handler that rejects with %s is recorded as failed, and start settles the next row',
  async (_name, thrown, recorded) => {
    const db = openDb()
    const { ledger: requester } = recordingLedger(db)
    const odd = requestProcedure(db, requester)
    const healthy = requestProcedure(db, requester)
    decideBehindTheLedger(db, odd)
    decideBehindTheLedger(db, healthy)
    let calls = 0
    const { ledger } = recordingLedger(db, () =>
      calls++ === 0 ? Promise.reject(thrown()) : Promise.resolve(),
    )

    await ledger.start()

    expect(ledger.show(odd)).toMatchObject({ handledAt: expect.any(Date), handlerError: recorded })
    expect(ledger.show(healthy)).toMatchObject({ handledAt: expect.any(Date), handlerError: null })
  },
)

test('a handler that throws synchronously is recorded as failed at decide and at start', async () => {
  const db = openDb()
  const { ledger } = recordingLedger(db, () => {
    throw new Error('sync boom')
  })
  const atDecide = requestProcedure(db, ledger)
  const atStart = requestProcedure(db, ledger)
  decideBehindTheLedger(db, atStart)

  const decided = await ledger.decide({ id: atDecide, decision: 'approve', by: host })
  await ledger.start()

  expect(decided.approval).toMatchObject({ handledAt: expect.any(Date), handlerError: 'sync boom' })
  expect(ledger.show(atStart)).toMatchObject({
    handledAt: expect.any(Date),
    handlerError: 'sync boom',
  })
})

test('when the outcome cannot be recorded, decide and start resolve, log it, and leave the row for the next start', async () => {
  const db = openDb()
  const { ledger, handled, logged } = recordingLedger(db)
  const id = requestProcedure(db, ledger)
  db.run(
    sql`CREATE TRIGGER disk_full BEFORE UPDATE OF handled_at ON pending_approval BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
  )

  const decided = await ledger.decide({ id, decision: 'approve', by: host })
  await ledger.start()

  expect(decided.message).toMatch(
    /^approved by host at .*, but recording its outcome failed, so its handler runs again at the next host start: disk full$/,
  )
  expect(ledger.show(id)).toMatchObject({ status: 'approved', handledAt: null })
  const unrecorded: ApprovalLog = {
    kind: 'approval.outcome.unrecorded',
    approvalId: id,
    error: 'disk full',
  }
  expect(logged).toEqual([unrecorded, unrecorded])

  db.run(sql`DROP TRIGGER disk_full`)
  await ledger.start()
  expect(ledger.show(id)).toMatchObject({ handledAt: expect.any(Date), handlerError: null })
  expect(handled).toHaveLength(3)
})

test('a failed handler logs one line with the approval id and the escaped error at decide and at start', async () => {
  const db = openDb()
  const { ledger, logged } = recordingLedger(db, crash('boom‮'))
  const atDecide = requestProcedure(db, ledger)
  const atStart = requestProcedure(db, ledger)
  decideBehindTheLedger(db, atStart)

  await ledger.decide({ id: atDecide, decision: 'approve', by: host })
  await ledger.start()

  expect(logged).toEqual([
    { kind: 'approval.handler.failed', approvalId: atDecide, error: 'boom\\u{202e}' },
    { kind: 'approval.handler.failed', approvalId: atStart, error: 'boom\\u{202e}' },
  ])
})

test('a human whose user id is host is not the host approver', async () => {
  const db = openDb()
  const { router, contextFor, held } = composedHost(db)
  const id = await held(agent, 'access/users/create', { id: 'slack:U1', displayName: 'Bob' })

  expect(
    await createRouterClient(router, { context: contextFor({ kind: 'human', userId: 'host' }) })
      .approval.decide([id, { approve: true }])
      .catch((caught: unknown) => caught),
  ).toMatchObject({ code: 'FORBIDDEN' })
  expect(ledgerRow(db, id).status).toBe('pending')
})

test.each([
  ['an agent calling a scoped procedure', agent, 'probe/scoped'],
  [
    'a non-owner human calling a held procedure',
    { kind: 'human', userId: 'slack:m' },
    'probe/note',
  ],
] as const)(
  'malformed input from %s is a 403 without schema issues through the approval guard',
  async (_name, caller, path) => {
    const db = openDb()
    const { post } = composedHost(db)

    const answer = await post(caller, path, { name: 42, text: 42 })

    expect(answer).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(JSON.stringify(answer)).not.toContain('issues')
    expect(db.select().from(pendingApproval).all()).toEqual([])
  },
)
