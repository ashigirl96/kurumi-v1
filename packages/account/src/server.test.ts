import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLedger } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import { guardRouter, type KurumiContext } from '@kurumi/rpc/server'
import { createRouterClient, ORPCError } from '@orpc/server'
import { eq, sql } from 'drizzle-orm'

import { KEY_MAX_LENGTH } from './contract.ts'
import { account, accountGrant, defaultAccount } from './schema.ts'
import {
  accountHandle,
  createAccountLedger,
  router,
  selectAccount,
  storedAccounts,
  type AccountLedger,
  type AddKeyInput,
  type CredentialDecision,
  type EgressRequest,
  type Selector,
  type ServiceId,
} from './server.ts'
import { inMemoryDb, insertAccount, insertAgentGroup } from './testing.ts'
import { open, seal } from './vault.ts'

const handleA = accountHandle('google', 'a@work.example')
const handleB = accountHandle('google', 'b@work.example')

const vaultKey = randomBytes(32)

let db: ReturnType<typeof inMemoryDb>
let ledger: AccountLedger

const grant = (agentGroupId: string, accountId: string, service: ServiceId) =>
  db.transaction((tx) => ledger.grant(tx, { agentGroupId, accountId, service, grantedBy: 'test' }))

const setDefault = (agentGroupId: string, accountId: string, service: ServiceId) =>
  db.transaction((tx) => ledger.setDefault(tx, { agentGroupId, accountId, service }))

const revoke = (agentGroupId: string, accountId: string, service: ServiceId) =>
  db.transaction((tx) => ledger.revoke(tx, { agentGroupId, accountId, service }))

const choose = (agentGroupId: string, service: ServiceId, selector: Selector = { kind: 'none' }) =>
  selectAccount(service, ledger.candidates(agentGroupId, service), selector)

const insertGrant = (vendor: string, accountId: string, service: string) =>
  db.$client
    .query(
      `INSERT INTO account_grant (agent_group_id, account_id, vendor, service, granted_by, granted_at)
       VALUES ('g1', ?, ?, ?, 'raw', 0)`,
    )
    .run(accountId, vendor, service)

const grantRows = () => db.select().from(accountGrant).all()
const defaultRows = () => db.select().from(defaultAccount).all()

beforeEach(() => {
  db = inMemoryDb()
  ledger = createAccountLedger({ db, vaultKey })
  for (const group of ['g1', 'g2', 'g3']) insertAgentGroup(db, group)
  insertAccount(db, {
    id: 'acc-a',
    vendor: 'google',
    label: 'a@work.example',
    services: ['gmail', 'google-calendar'],
  })
  insertAccount(db, {
    id: 'acc-b',
    vendor: 'google',
    label: 'b@work.example',
    services: ['gmail', 'google-calendar'],
  })
  insertAccount(db, { id: 'acc-c', vendor: 'google', label: 'c@work.example', services: ['gmail'] })
  insertAccount(db, { id: 'acc-n', vendor: 'notion', label: 'team', services: ['notion'] })
})

function seedGroups() {
  for (const accountId of ['acc-a', 'acc-b', 'acc-c']) grant('g1', accountId, 'gmail')
  setDefault('g1', 'acc-a', 'gmail')
  grant('g2', 'acc-b', 'gmail')
  grant('g2', 'acc-a', 'google-calendar')
  setDefault('g2', 'acc-b', 'gmail')
}

describe('choosing the account for a request', () => {
  beforeEach(seedGroups)

  test('a group with several grants and a default uses the default when no account is named', () => {
    expect(choose('g1', 'gmail')).toMatchObject({ ok: true, handle: handleA, how: 'default' })
  })

  test('a named account wins over the default', () => {
    expect(choose('g1', 'gmail', { kind: 'handle', handle: handleB })).toMatchObject({
      ok: true,
      handle: handleB,
      how: 'named',
    })
  })

  test('a group with one grant for the service uses it', () => {
    expect(choose('g2', 'google-calendar')).toMatchObject({
      ok: true,
      handle: handleA,
      how: 'only',
    })
  })

  test('an account the group was not granted for that service is refused, whichever other group holds it', () => {
    expect(choose('g2', 'gmail', { kind: 'handle', handle: handleA })).toEqual({
      ok: false,
      refusal: {
        code: 'account_not_granted',
        service: 'gmail',
        named: handleA,
        granted: [handleB],
      },
    })
  })

  test('a group without a grant for the service is told it has no account connected', () => {
    expect(choose('g3', 'gmail')).toEqual({
      ok: false,
      refusal: { code: 'account_not_connected', service: 'gmail' },
    })
  })

  test('several grants and no default are ambiguous', () => {
    revoke('g1', 'acc-a', 'gmail')
    grant('g1', 'acc-a', 'gmail')

    expect(choose('g1', 'gmail')).toEqual({
      ok: false,
      refusal: {
        code: 'account_ambiguous',
        service: 'gmail',
        granted: [handleA, handleB, accountHandle('google', 'c@work.example')],
      },
    })
  })

  test('an account that needs re-authorization is refused with its handle', () => {
    db.run(sql`UPDATE account SET status = 'needs_reauth' WHERE id = 'acc-b'`)

    expect(choose('g2', 'gmail')).toEqual({
      ok: false,
      refusal: { code: 'account_needs_reauth', service: 'gmail', handle: handleB },
    })
  })

  test('the default is the last one set', () => {
    setDefault('g1', 'acc-c', 'gmail')

    expect(choose('g1', 'gmail')).toMatchObject({ ok: true, how: 'default' })
    expect(ledger.candidates('g1', 'gmail').filter(({ isDefault }) => isDefault)).toHaveLength(1)
    expect(defaultRows().filter((row) => row.agentGroupId === 'g1')).toHaveLength(1)
  })
})

describe('granting', () => {
  test('a service the account does not cover is refused and adds no row', () => {
    const result = grant('g1', 'acc-c', 'google-calendar')

    expect(result).toEqual({ ok: false, refusal: 'service_not_covered' })
    expect(grantRows()).toEqual([])
  })

  test('an agent group that does not exist is refused', () => {
    expect(grant('g-missing', 'acc-a', 'gmail')).toEqual({
      ok: false,
      refusal: 'agent_group_not_found',
    })
    expect(grantRows()).toEqual([])
  })

  test('an account that does not exist is refused', () => {
    expect(grant('g1', 'acc-missing', 'gmail')).toEqual({
      ok: false,
      refusal: 'account_not_found',
    })
  })

  test('granting twice keeps one row', () => {
    grant('g1', 'acc-a', 'gmail')
    grant('g1', 'acc-a', 'gmail')

    expect(grantRows()).toHaveLength(1)
  })

  test('a default needs the grant it rests on', () => {
    expect(setDefault('g1', 'acc-a', 'gmail')).toEqual({ ok: false, refusal: 'grant_not_found' })
    expect(defaultRows()).toEqual([])
  })

  test('revoking a grant removes the default that rested on it', () => {
    seedGroups()

    revoke('g1', 'acc-a', 'gmail')

    expect(defaultRows().filter((row) => row.agentGroupId === 'g1')).toEqual([])
    expect(ledger.candidates('g1', 'gmail')).toHaveLength(2)
  })

  test('removing an agent group removes its grants and defaults and leaves the others', () => {
    seedGroups()

    db.run(sql`DELETE FROM agent_group WHERE id = 'g1'`)

    expect(grantRows().map((row) => row.agentGroupId)).toEqual(['g2', 'g2'])
    expect(defaultRows().map((row) => row.agentGroupId)).toEqual(['g2'])
  })
})

const secret = 'sk-ant-oat01-secret'

const addKey = (input: Partial<AddKeyInput> = {}) =>
  db.transaction((tx) =>
    ledger.addKey(tx, {
      vendor: 'anthropic',
      label: 'main',
      value: secret,
      autoGrant: false,
      ...input,
    }),
  )

const accountRow = (label: string) =>
  db
    .select()
    .from(account)
    .all()
    .find((row) => row.label === label)

describe('key accounts', () => {
  test('add-key stores the key sealed under the account id', () => {
    expect(addKey()).toEqual({ ok: true, handle: accountHandle('anthropic', 'main') })

    const row = accountRow('main')
    expect(row).toMatchObject({
      vendor: 'anthropic',
      kind: 'key',
      subject: null,
      authMode: 'api-key',
      services: ['anthropic-api'],
      status: 'active',
      autoGrant: false,
    })
    expect(row?.id).toMatch(/^acc-/)
    expect(row?.material.includes(Buffer.from(secret))).toBe(false)
    expect(JSON.parse(open(vaultKey, row?.id ?? '', row?.material ?? Buffer.alloc(0)))).toEqual({
      kind: 'key',
      key: secret,
    })
  })

  test('the auth mode named is stored, and a vendor without modes stores none', () => {
    addKey({ authMode: 'oauth-token' })
    addKey({ vendor: 'github', label: 'gh' })

    expect(accountRow('main')?.authMode).toBe('oauth-token')
    expect(accountRow('gh')?.authMode).toBeNull()
  })

  test('an auth mode the vendor lacks is refused and adds no row', () => {
    expect(addKey({ vendor: 'github', label: 'gh', authMode: 'api-key' })).toEqual({
      ok: false,
      refusal: 'auth_mode_not_supported',
    })
    expect(accountRow('gh')).toBeUndefined()
  })

  test('a duplicate label is refused and the first key stays the only row', () => {
    addKey()
    const first = accountRow('main')
    expect(first).toBeDefined()

    expect(addKey({ value: 'sk-ant-other', authMode: 'oauth-token' })).toEqual({
      ok: false,
      refusal: 'label_taken',
    })
    expect(
      db
        .select()
        .from(account)
        .all()
        .filter((row) => row.vendor === 'anthropic'),
    ).toEqual(first ? [first] : [])
  })

  test('the same label under another vendor is a different account', () => {
    addKey()

    expect(addKey({ vendor: 'github' })).toMatchObject({ ok: true, handle: 'github/main' })
  })

  test('an auto-grant key is granted to every existing group for every service it covers', () => {
    addKey({ autoGrant: true })

    const { id } = accountRow('main') ?? {}
    expect(
      grantRows()
        .filter((row) => row.accountId === id)
        .map(({ agentGroupId, service, grantedBy }) => ({ agentGroupId, service, grantedBy }))
        .toSorted((a, b) => a.agentGroupId.localeCompare(b.agentGroupId)),
    ).toEqual(
      ['g1', 'g2', 'g3'].map((agentGroupId) => ({
        agentGroupId,
        service: 'anthropic-api',
        grantedBy: 'auto-grant',
      })),
    )
  })

  test('a key without auto-grant is granted to no group', () => {
    addKey()

    expect(grantRows()).toEqual([])
  })

  test('grantAutoGrants gives a group every auto-grant account once, however often it runs', () => {
    addKey({ autoGrant: true })
    addKey({ vendor: 'github', label: 'gh' })
    insertAgentGroup(db, 'g4')

    for (let run = 0; run < 2; run++) db.transaction((tx) => ledger.grantAutoGrants(tx, 'g4'))

    expect(
      grantRows()
        .filter((row) => row.agentGroupId === 'g4')
        .map(({ service, grantedBy }) => ({ service, grantedBy })),
    ).toEqual([{ service: 'anthropic-api', grantedBy: 'auto-grant' }])
  })

  test('list shows every account by handle, without material, ordered by handle', () => {
    addKey({ authMode: 'oauth-token', autoGrant: true })

    const views = ledger.list()

    expect(views.map(({ handle }): string => handle)).toEqual([
      'anthropic/main',
      'google/a@work.example',
      'google/b@work.example',
      'google/c@work.example',
      'notion/team',
    ])
    expect(views[0]).toEqual({
      handle: accountHandle('anthropic', 'main'),
      kind: 'key',
      authMode: 'oauth-token',
      services: ['anthropic-api'],
      autoGrant: true,
    })
  })

  test('removing an account removes its grants and defaults and leaves the others', () => {
    seedGroups()

    expect(db.transaction((tx) => ledger.remove(tx, 'google/a@work.example'))).toEqual({
      ok: true,
    })

    expect(accountRow('a@work.example')).toBeUndefined()
    expect(grantRows().filter((row) => row.accountId === 'acc-a')).toEqual([])
    expect(
      defaultRows().map(({ agentGroupId, accountId }) => ({ agentGroupId, accountId })),
    ).toEqual([{ agentGroupId: 'g2', accountId: 'acc-b' }])
    expect(grantRows()).toHaveLength(3)
  })

  test.each([
    ['google/nobody@work.example', 'account_not_found'],
    ['unknown/main', 'invalid_handle'],
    ['google', 'invalid_handle'],
    ['google/', 'invalid_handle'],
  ] as const)('removing %p is refused as %s', (handle, refusal) => {
    expect(db.transaction((tx) => ledger.remove(tx, handle))).toEqual({ ok: false, refusal })
    expect(db.select().from(account).all()).toHaveLength(4)
  })

  test('a label holding a slash is found by its handle', () => {
    addKey({ label: 'team/main' })

    expect(db.transaction((tx) => ledger.accountIdOf(tx, 'anthropic/team/main'))).toEqual({
      ok: true,
      accountId: accountRow('team/main')?.id ?? '',
    })
  })

  test('clearing a default keeps the grant it rested on', () => {
    seedGroups()

    db.transaction((tx) => ledger.clearDefault(tx, { agentGroupId: 'g1', service: 'gmail' }))

    expect(defaultRows().map(({ agentGroupId }) => agentGroupId)).toEqual(['g2'])
    expect(ledger.candidates('g1', 'gmail')).toHaveLength(3)
  })
})

describe('stored accounts', () => {
  test('are sealed with the key that added them and not with another key', () => {
    const stored = inMemoryDb()
    const keyLedger = createAccountLedger({ db: stored, vaultKey })
    for (const label of ['main', 'spare']) {
      stored.transaction((tx) =>
        keyLedger.addKey(tx, { vendor: 'anthropic', label, value: secret, autoGrant: false }),
      )
    }

    expect(storedAccounts(stored).count).toBe(2)
    expect(storedAccounts(stored).sealedWith(vaultKey)).toBe(true)
    expect(storedAccounts(stored).sealedWith(randomBytes(32))).toBe(false)
  })

  test('a damaged row does not make the key that sealed the others a mismatch', () => {
    const stored = inMemoryDb()
    insertAccount(stored, {
      id: 'acc-damaged',
      vendor: 'anthropic',
      label: 'old',
      services: ['anthropic-api'],
    })
    const keyLedger = createAccountLedger({ db: stored, vaultKey })
    stored.transaction((tx) =>
      keyLedger.addKey(tx, { vendor: 'anthropic', label: 'main', value: secret, autoGrant: false }),
    )

    expect(storedAccounts(stored).count).toBe(2)
    expect(storedAccounts(stored).sealedWith(vaultKey)).toBe(true)
    expect(storedAccounts(stored).sealedWith(randomBytes(32))).toBe(false)
  })

  test('none means any key will do', () => {
    expect(storedAccounts(inMemoryDb()).count).toBe(0)
    expect(storedAccounts(inMemoryDb()).sealedWith(randomBytes(32))).toBe(true)
  })
})

describe('auto-grant on agent create', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kurumi-account-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test('a new agent group gets every auto-grant account in the create transaction', () => {
    addKey({ autoGrant: true })
    addKey({ vendor: 'github', label: 'gh' })
    const agents = createAgentLedger({
      db,
      home,
      onCreate: (tx, agentGroupId) => ledger.grantAutoGrants(tx, agentGroupId),
    })

    const created = agents.create({ name: 'home' })

    expect(
      grantRows()
        .filter((row) => row.agentGroupId === created.id)
        .map(({ accountId, service, grantedBy }) => ({ accountId, service, grantedBy })),
    ).toEqual([
      {
        accountId: accountRow('main')?.id ?? '',
        service: 'anthropic-api',
        grantedBy: 'auto-grant',
      },
    ])
  })
})

const client = (caller: Caller = { kind: 'host' }) =>
  createRouterClient(
    guardRouter<KurumiContext & { accountLedger: AccountLedger }>().router(router),
    {
      context: {
        db,
        caller,
        guard: () => ({ kind: 'allow' }),
        grant: null,
        accountLedger: ledger,
      },
    },
  )

const failure = async (call: Promise<unknown>) => {
  try {
    await call
  } catch (error) {
    if (error instanceof ORPCError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('the account router', () => {
  test('add-key returns the handle and records its grants as auto-grant', async () => {
    expect(
      await client({ kind: 'human', userId: 'u1' }).addKey([
        'anthropic',
        { label: 'main', value: secret, autoGrant: true, auth: 'oauth-token' },
      ]),
    ).toEqual({ handle: 'anthropic/main' })
    expect(grantRows().map(({ grantedBy }) => grantedBy)).toEqual([
      'auto-grant',
      'auto-grant',
      'auto-grant',
    ])
    expect(await client().list()).toContainEqual({
      handle: 'anthropic/main',
      kind: 'key',
      authMode: 'oauth-token',
      services: ['anthropic-api'],
      autoGrant: true,
    })
  })

  test('a duplicate label is a CONFLICT naming the handle and never the key', async () => {
    await client().addKey(['anthropic', { label: 'main', value: secret }])

    const error = await failure(client().addKey(['anthropic', { label: 'main', value: secret }]))

    expect(error).toEqual({ code: 'CONFLICT', message: 'anthropic/main already exists' })
  })

  test('an auth mode the vendor lacks is a BAD_REQUEST', async () => {
    expect(
      await failure(client().addKey(['github', { label: 'gh', value: secret, auth: 'api-key' }])),
    ).toEqual({ code: 'BAD_REQUEST', message: 'github has no auth mode api-key; it takes none' })
  })

  test.each([
    ['whitespace', 'sk-ant one', 'value contains whitespace'],
    ['a trailing newline', 'sk-ant-one\n', 'value contains whitespace'],
    ['an embedded newline', 'sk-ant\none', 'value contains whitespace'],
    ['a NUL', 'sk-ant\0one', 'value contains a control character'],
    ['a replacement character', 'sk-ant-�', 'value contains a non-ASCII character'],
    [
      'too many characters',
      'k'.repeat(KEY_MAX_LENGTH + 1),
      `value is longer than ${KEY_MAX_LENGTH} characters`,
    ],
  ])(
    'a key with %s is a BAD_REQUEST that names the problem, never the key, and adds no row',
    async (_, value, problem) => {
      let caught: unknown
      try {
        await client().addKey(['anthropic', { label: 'main', value }])
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(ORPCError)
      const error = caught instanceof ORPCError ? caught : undefined
      expect(error?.code).toBe('BAD_REQUEST')
      expect(JSON.stringify(error?.data)).toContain(problem)
      expect(JSON.stringify({ message: error?.message, data: error?.data })).not.toContain(value)
      expect(accountRow('main')).toBeUndefined()
    },
  )

  test(`a key of exactly ${KEY_MAX_LENGTH} printable characters is stored`, async () => {
    const value = 'k'.repeat(KEY_MAX_LENGTH)

    await client().addKey(['anthropic', { label: 'main', value }])

    const row = accountRow('main')
    expect(JSON.parse(open(vaultKey, row?.id ?? '', row?.material ?? Buffer.alloc(0))).key).toBe(
      value,
    )
  })

  test('grant, set and clear a default, revoke and remove, each by handle', async () => {
    const target = { service: 'gmail', agentGroupId: 'g3' } as const

    await client().grant(['google/a@work.example', target])
    await client().setDefault(['google/a@work.example', target])
    expect(ledger.candidates('g3', 'gmail')).toEqual([
      { accountId: 'acc-a', handle: handleA, isDefault: true, status: 'active' },
    ])
    expect(grantRows().find((row) => row.agentGroupId === 'g3')?.grantedBy).toBe('host')

    await client().clearDefault(target)
    expect(defaultRows()).toEqual([])

    await client().revoke(['google/a@work.example', target])
    expect(grantRows()).toEqual([])

    await client().remove(['google/a@work.example'])
    expect(accountRow('a@work.example')).toBeUndefined()
  })

  test('refusals map to NOT_FOUND for a missing account or group and BAD_REQUEST otherwise', async () => {
    const target = { service: 'gmail', agentGroupId: 'g1' } as const

    expect(await failure(client().grant(['google/nobody', target]))).toEqual({
      code: 'NOT_FOUND',
      message: 'no account google/nobody',
    })
    expect(
      await failure(
        client().grant(['google/a@work.example', { ...target, agentGroupId: 'g-missing' }]),
      ),
    ).toEqual({ code: 'NOT_FOUND', message: 'no agent group g-missing' })
    expect(
      await failure(
        client().grant(['google/c@work.example', { ...target, service: 'google-calendar' }]),
      ),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: 'google/c@work.example does not cover google-calendar',
    })
    expect(await failure(client().setDefault(['google/a@work.example', target]))).toEqual({
      code: 'BAD_REQUEST',
      message: 'google/a@work.example is not granted gmail for g1',
    })
    expect(await failure(client().remove(['nope/x']))).toEqual({
      code: 'BAD_REQUEST',
      message: 'nope/x is not <vendor>/<label> with a known vendor',
    })
  })

  test('an agent caller is refused every procedure', async () => {
    const agent = client({ kind: 'agent', agentGroupId: 'g1', sessionId: 's1' })

    for (const call of [
      agent.list(),
      agent.addKey(['anthropic', { label: 'main', value: secret }]),
      agent.remove(['google/a@work.example']),
    ]) {
      expect((await failure(call)).code).toBe('FORBIDDEN')
    }
    expect(accountRow('main')).toBeUndefined()
  })
})

describe('what the database refuses without the ledger', () => {
  test.each([null, 'password'])(
    'an anthropic account with auth mode %p fails the CHECK',
    (mode) => {
      expect(() =>
        db.$client
          .query(
            `INSERT INTO account (id, vendor, label, kind, auth_mode, services, material, status, created_at)
           VALUES ('acc-x', 'anthropic', 'x', 'key', ?, '["anthropic-api"]', x'', 'active', 0)`,
          )
          .run(mode),
      ).toThrow(/CHECK constraint failed: account_auth_mode_of_vendor/)
    },
  )

  test('a service of another vendor fails the CHECK', () => {
    expect(() => insertGrant('google', 'acc-a', 'notion')).toThrow(
      /CHECK constraint failed: account_grant_service_of_vendor/,
    )
  })

  test('a vendor that differs from the account fails the foreign key', () => {
    expect(() => insertGrant('notion', 'acc-a', 'notion')).toThrow(/FOREIGN KEY constraint failed/)
    expect(grantRows()).toEqual([])
  })

  test('a default without a grant fails the foreign key', () => {
    expect(() =>
      db.$client.run(
        `INSERT INTO default_account (agent_group_id, service, account_id, vendor)
         VALUES ('g1', 'gmail', 'acc-a', 'google')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })
})

const sealMaterial = (accountId: string, plaintext: string, sealedFor = accountId) =>
  db
    .update(account)
    .set({ material: seal(vaultKey, sealedFor, plaintext) })
    .where(eq(account.id, accountId))
    .run()

const sealKey = (accountId: string, key: string) =>
  sealMaterial(accountId, JSON.stringify({ kind: 'key', key }))

type HeaderLines = readonly (readonly [string, string])[]

const egress = (
  host: string,
  path: string,
  lines: HeaderLines = [],
  method = 'GET',
): EgressRequest => {
  const headers = new Headers()
  for (const [name, value] of lines) headers.append(name, value)
  return { host, method, path, headers, rawHeaders: lines.flat() }
}

const decide = (agentGroupId: string, request: EgressRequest) =>
  ledger.credentialFor({ agentGroupId }, request)

function sent(decision: CredentialDecision) {
  if (decision.kind !== 'inject') throw new Error(`expected an injection, not ${decision.kind}`)
  const { path, headers } = decision.injection.apply()
  return { handle: decision.injection.handle, path, headers: Object.fromEntries(headers) }
}

const anthropicApi = (lines: HeaderLines = [], path = '/v1/messages', method = 'GET') =>
  egress('api.anthropic.com', path, lines, method)

const anthropicGroupSelector = 'sk-ant-kurumi-YW50aHJvcGlj'
const secondSecret = 'sk-ant-api03-second'
const oauthBeta = 'oauth-2025-04-20'
const sdkApiKeyBetas =
  'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,thinking-display-updates-2026-08-18'
const sdkOauthBetas =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,thinking-display-updates-2026-08-18,extended-cache-ttl-2025-04-11'

const idOf = (label: string) => accountRow(label)?.id ?? ''

describe('the credential for a Google request', () => {
  const handleC = accountHandle('google', 'c@work.example')
  const gmail = (authorization?: string) =>
    egress(
      'gmail.googleapis.com',
      '/gmail/v1/users/me/messages',
      authorization === undefined ? [] : [['Authorization', authorization]],
    )
  const calendar = egress('www.googleapis.com', '/calendar/v3/calendars/primary/events')

  beforeEach(() => {
    seedGroups()
    sealKey('acc-a', 'ya29.key-of-a')
    sealKey('acc-b', 'ya29.key-of-b')
    sealKey('acc-c', 'ya29.key-of-c')
  })

  test.each([
    ['group 1 naming no account gets its default', 'g1', gmail(), handleA, 'ya29.key-of-a'],
    [
      'group 1 naming c gets c',
      'g1',
      gmail('Bearer kurumi:google/c@work.example'),
      handleC,
      'ya29.key-of-c',
    ],
    ['group 2 naming no account gets its gmail default', 'g2', gmail(), handleB, 'ya29.key-of-b'],
    ['group 2 calendar uses its only grant', 'g2', calendar, handleA, 'ya29.key-of-a'],
  ])('%s', (_name, group, request, handle, key) => {
    expect(sent(decide(group, request))).toEqual({
      handle,
      path: request.path,
      headers: { authorization: `Bearer ${key}` },
    })
  })

  test('an account the group was not granted is refused with the handles it was', () => {
    expect(decide('g2', gmail('Bearer kurumi:google/a@work.example'))).toEqual({
      kind: 'refuse',
      refusal: {
        code: 'account_not_granted',
        service: 'gmail',
        named: handleA,
        granted: [handleB],
      },
    })
  })

  test('a group without a grant for the service is not connected', () => {
    expect(decide('g3', gmail())).toEqual({
      kind: 'refuse',
      refusal: { code: 'account_not_connected', service: 'gmail' },
    })
  })

  test('several grants are ambiguous once the default is cleared', () => {
    db.transaction((tx) => ledger.clearDefault(tx, { agentGroupId: 'g1', service: 'gmail' }))

    expect(decide('g1', gmail())).toEqual({
      kind: 'refuse',
      refusal: {
        code: 'account_ambiguous',
        service: 'gmail',
        granted: [handleA, handleB, handleC],
      },
    })
  })

  test('a path on an intercepted host that names no service passes untouched', () => {
    expect(
      decide('g1', egress('www.googleapis.com', '/discovery/v1/apis', [['Authorization', 'x']])),
    ).toEqual({ kind: 'pass' })
  })

  test.each([
    ['an empty sealed plaintext', () => sealMaterial('acc-b', '')],
    ['an empty buffer', () => db.run(sql`UPDATE account SET material = x'' WHERE id = 'acc-b'`)],
    ['material sealed for another account', () => sealMaterial('acc-b', '{}', 'acc-a')],
    ['material that is not JSON', () => sealMaterial('acc-b', 'not json')],
    [
      'material that holds no key',
      () => sealMaterial('acc-b', JSON.stringify({ kind: 'oauth', accessToken: 'ya29.x' })),
    ],
  ])('%s makes the chosen account need re-authorization', (_name, spoil) => {
    spoil()

    expect(decide('g2', gmail())).toEqual({
      kind: 'refuse',
      refusal: { code: 'account_needs_reauth', service: 'gmail', handle: handleB },
    })
  })
})

describe('the slot an Anthropic account is written to', () => {
  test.each([
    [
      'an oauth-token account read from Authorization',
      'oauth-token',
      [['Authorization', `Bearer ${anthropicGroupSelector}`]],
      {
        authorization: `Bearer ${secret}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': oauthBeta,
      },
    ],
    [
      'an oauth-token account read from x-api-key',
      'oauth-token',
      [['X-Api-Key', anthropicGroupSelector]],
      {
        authorization: `Bearer ${secret}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': oauthBeta,
      },
    ],
    [
      'an api-key account read from x-api-key',
      'api-key',
      [['X-Api-Key', anthropicGroupSelector]],
      { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
    ],
    [
      'an api-key account named in Authorization',
      'api-key',
      [['Authorization', 'Bearer kurumi:anthropic/main']],
      { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
    ],
    [
      'an api-key account under the client own Authorization',
      'api-key',
      [
        ['Authorization', 'Bearer sk-ant-oat01-client-own'],
        ['X-Api-Key', anthropicGroupSelector],
      ],
      { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
    ],
  ] as const)('%s', (_name, authMode, lines, headers) => {
    addKey({ authMode, autoGrant: true })

    const request = anthropicApi([...lines, ['anthropic-version', '2023-06-01']])

    expect(sent(decide('g1', request))).toEqual({
      handle: accountHandle('anthropic', 'main'),
      path: '/v1/messages',
      headers,
    })
  })

  test.each(['api-key', 'oauth-token'] as const)(
    'the raw path of an %s account goes upstream as written',
    (authMode) => {
      addKey({ authMode, autoGrant: true })
      const path = '/v1/./models/../messages?beta=%2Fx%41&q=a+b'

      expect(sent(decide('g1', anthropicApi([], path))).path).toBe(path)
    },
  )

  test.each([
    [
      'authorization',
      [
        ['Authorization', 'Bearer kurumi:anthropic/main'],
        ['authorization', 'x'],
      ],
    ],
    [
      'x-api-key',
      [
        ['X-Api-Key', anthropicGroupSelector],
        ['x-api-key', 'sk-ant-other'],
      ],
    ],
  ] as const)('two %s lines are refused before any account is chosen', (header, lines) => {
    addKey({ autoGrant: true })

    expect(decide('g1', anthropicApi(lines))).toEqual({
      kind: 'refuse',
      refusal: { code: 'duplicate_slot', service: 'anthropic-api', header },
    })
  })

  test('x-api-key beside X_Api_Key is a duplicate slot', () => {
    addKey({ autoGrant: true })

    const request = anthropicApi([
      ['X-Api-Key', anthropicGroupSelector],
      ['X_Api_Key', 'sk-ant-other'],
    ])

    expect(decide('g1', request)).toEqual({
      kind: 'refuse',
      refusal: { code: 'duplicate_slot', service: 'anthropic-api', header: 'x-api-key' },
    })
  })

  test.each([
    ['x_api_key', 'api-key', { 'x-api-key': secret }],
    [
      'X-Api_Key',
      'oauth-token',
      { authorization: `Bearer ${secret}`, 'anthropic-beta': oauthBeta },
    ],
  ] as const)(
    'a %s header does not reach the upstream beside an %s account',
    (name, authMode, headers) => {
      addKey({ authMode, autoGrant: true })

      const request = anthropicApi([[name, 'sk-ant-api03-client-own']])

      expect(sent(decide('g1', request)).headers).toEqual(headers)
    },
  )

  test('a selector in x_api_key names the account like one in x-api-key', () => {
    addKey({ autoGrant: true })
    addKey({ label: 'second', value: secondSecret, autoGrant: true })
    setDefault('g1', idOf('main'), 'anthropic-api')

    const request = anthropicApi([['x_api_key', 'kurumi:anthropic/second']])

    expect(sent(decide('g1', request))).toMatchObject({
      handle: accountHandle('anthropic', 'second'),
      headers: { 'x-api-key': secondSecret },
    })
  })

  test.each([
    ['the Agent SDK in OAuth mode', [['anthropic-beta', sdkOauthBetas]], sdkOauthBetas],
    [
      'the Agent SDK in API-key mode',
      [['anthropic-beta', sdkApiKeyBetas]],
      `${sdkApiKeyBetas},${oauthBeta}`,
    ],
    ['no beta header', [], oauthBeta],
    ['an empty beta header', [['anthropic-beta', '']], oauthBeta],
    [
      'the OAuth beta on a second line',
      [
        ['anthropic-beta', 'claude-code-20250219'],
        ['anthropic-beta', oauthBeta],
      ],
      `claude-code-20250219,${oauthBeta}`,
    ],
  ] as const)(
    'an oauth-token account lists the OAuth beta once after %s',
    (_client, lines, beta) => {
      addKey({ authMode: 'oauth-token', autoGrant: true })

      expect(sent(decide('g1', anthropicApi(lines))).headers['anthropic-beta']).toBe(beta)
    },
  )

  test.each([
    ['the Agent SDK in API-key mode', [['anthropic-beta', sdkApiKeyBetas]], sdkApiKeyBetas],
    [
      'the Agent SDK in OAuth mode',
      [['anthropic-beta', sdkOauthBetas]],
      sdkOauthBetas.replace(`,${oauthBeta}`, ''),
    ],
    ['only the OAuth beta', [['anthropic-beta', oauthBeta]], undefined],
  ] as const)('an api-key account drops only the OAuth beta after %s', (_client, lines, beta) => {
    addKey({ authMode: 'api-key', autoGrant: true })

    expect(sent(decide('g1', anthropicApi(lines))).headers['anthropic-beta']).toBe(beta)
  })

  test('a selector kurumi cannot read is refused with the selectors the group may write', () => {
    addKey({ autoGrant: true })
    addKey({ label: 'second', value: secondSecret, autoGrant: true })

    const request = anthropicApi([['Authorization', 'Bearer sk-ant-kurumi-anthropic/second']])

    expect(decide('g1', request)).toEqual({
      kind: 'refuse',
      refusal: {
        code: 'selector_unreadable',
        service: 'anthropic-api',
        written: 'sk-ant-kurumi-anthropic/second',
        accepted: [
          'sk-ant-kurumi-YW50aHJvcGljL21haW4',
          'kurumi:anthropic/main',
          'sk-ant-kurumi-YW50aHJvcGljL3NlY29uZA',
          'kurumi:anthropic/second',
        ],
      },
    })
  })

  test('an injection holds its secret only for apply', () => {
    addKey({ autoGrant: true })

    const decision = decide('g1', anthropicApi())
    if (decision.kind !== 'inject') throw new Error(`expected an injection, not ${decision.kind}`)

    expect(decision.injection.apply().headers.get('x-api-key')).toBe(secret)
    expect(() => JSON.stringify(decision)).toThrow(
      'an Injection holds a credential and cannot be serialized',
    )
    expect(Bun.inspect(decision)).not.toContain(secret)
  })
})

const clientLines = (env: Record<string, string>): [string, string][] =>
  Object.entries(env).map(([name, value]) =>
    name === 'CLAUDE_CODE_OAUTH_TOKEN'
      ? ['Authorization', `Bearer ${value}`]
      : ['X-Api-Key', value],
  )

const fromContainer = () => decide('g1', anthropicApi(clientLines(ledger.containerEnv('g1'))))

describe('the container env as the client credential', () => {
  test('one grant is used', () => {
    addKey({ autoGrant: true })

    expect(sent(fromContainer())).toMatchObject({ handle: 'anthropic/main' })
  })

  test('the default is used among several grants', () => {
    addKey({ autoGrant: true })
    addKey({ label: 'second', value: secondSecret, authMode: 'oauth-token', autoGrant: true })
    setDefault('g1', idOf('second'), 'anthropic-api')

    expect(sent(fromContainer())).toMatchObject({
      handle: 'anthropic/second',
      headers: { authorization: `Bearer ${secondSecret}` },
    })
  })

  test('several grants without a default are ambiguous', () => {
    addKey({ autoGrant: true })
    addKey({ label: 'second', value: secondSecret, autoGrant: true })

    expect(fromContainer()).toEqual({
      kind: 'refuse',
      refusal: {
        code: 'account_ambiguous',
        service: 'anthropic-api',
        granted: [accountHandle('anthropic', 'main'), accountHandle('anthropic', 'second')],
      },
    })
  })

  test('no grant is not connected', () => {
    expect(fromContainer()).toEqual({
      kind: 'refuse',
      refusal: { code: 'account_not_connected', service: 'anthropic-api' },
    })
  })
})

describe('the methods a credential travels on', () => {
  const allowed = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

  test.each(allowed)('%s carries the credential', (method) => {
    addKey({ autoGrant: true })

    expect(decide('g1', anthropicApi([], '/v1/messages', method)).kind).toBe('inject')
  })

  test.each(['TRACE', 'TRACK', 'CONNECT', 'OPTIONS', 'PROPFIND'])(
    '%s is refused and carries no credential',
    (method) => {
      addKey({ autoGrant: true })

      expect(decide('g1', anthropicApi([], '/v1/messages', method))).toEqual({
        kind: 'refuse',
        refusal: { code: 'method_not_allowed', service: 'anthropic-api', method, allowed },
      })
    },
  )
})

test('the selector a container got at spawn follows every later grant change', () => {
  const [selector = ''] = Object.values(ledger.containerEnv('g1'))
  const decideAsSpawned = () =>
    decide('g1', anthropicApi([['Authorization', `Bearer ${selector}`]]))
  const main = accountHandle('anthropic', 'main')
  const second = accountHandle('anthropic', 'second')

  addKey({ authMode: 'oauth-token', autoGrant: true })
  expect(sent(decideAsSpawned())).toMatchObject({
    handle: main,
    headers: { authorization: `Bearer ${secret}` },
  })

  addKey({ label: 'second', value: secondSecret, authMode: 'oauth-token', autoGrant: true })
  expect(decideAsSpawned()).toEqual({
    kind: 'refuse',
    refusal: { code: 'account_ambiguous', service: 'anthropic-api', granted: [main, second] },
  })

  setDefault('g1', idOf('second'), 'anthropic-api')
  expect(sent(decideAsSpawned())).toMatchObject({
    handle: second,
    headers: { authorization: `Bearer ${secondSecret}` },
  })

  revoke('g1', idOf('second'), 'anthropic-api')
  expect(sent(decideAsSpawned())).toMatchObject({ handle: main })

  db.transaction((tx) => {
    ledger.remove(tx, main)
    ledger.remove(tx, second)
  })
  expect(decideAsSpawned()).toEqual({
    kind: 'refuse',
    refusal: { code: 'account_not_connected', service: 'anthropic-api' },
  })
})

describe('the container env', () => {
  test('with no grant holds the Group Selector in the vendor default mode', () => {
    expect(ledger.containerEnv('g1')).toEqual({ ANTHROPIC_API_KEY: anthropicGroupSelector })
  })

  test('with one oauth-token grant holds the Group Selector as the OAuth token', () => {
    addKey({ authMode: 'oauth-token', autoGrant: true })

    expect(ledger.containerEnv('g1')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: anthropicGroupSelector })
  })

  test('with one api-key grant holds the Group Selector as the API key', () => {
    addKey({ authMode: 'api-key', autoGrant: true })

    expect(ledger.containerEnv('g1')).toEqual({ ANTHROPIC_API_KEY: anthropicGroupSelector })
  })

  test('with mixed modes follows the default', () => {
    addKey({ authMode: 'api-key', autoGrant: true })
    addKey({ label: 'second', value: secondSecret, authMode: 'oauth-token', autoGrant: true })
    setDefault('g1', idOf('second'), 'anthropic-api')

    expect(ledger.containerEnv('g1')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: anthropicGroupSelector })
  })

  test('with mixed modes and no default falls back to the vendor default mode', () => {
    addKey({ authMode: 'oauth-token', autoGrant: true })
    addKey({ label: 'second', value: secondSecret, authMode: 'api-key', autoGrant: true })

    expect(ledger.containerEnv('g1')).toEqual({ ANTHROPIC_API_KEY: anthropicGroupSelector })
  })

  test('with several grants in one mode and no default uses that mode', () => {
    addKey({ authMode: 'oauth-token', autoGrant: true })
    addKey({ label: 'second', value: secondSecret, authMode: 'oauth-token', autoGrant: true })

    expect(ledger.containerEnv('g1')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: anthropicGroupSelector })
  })
})
