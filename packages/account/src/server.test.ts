import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLedger } from '@kurumi/agent/server'
import type { Caller } from '@kurumi/rpc/contract'
import { guardRouter, type KurumiContext } from '@kurumi/rpc/server'
import { createRouterClient, ORPCError } from '@orpc/server'
import { sql } from 'drizzle-orm'

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
  type Selector,
  type ServiceId,
} from './server.ts'
import { inMemoryDb, insertAccount, insertAgentGroup } from './testing.ts'
import { open } from './vault.ts'

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
