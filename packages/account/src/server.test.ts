import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { accountGrant, defaultAccount } from './schema.ts'
import {
  accountHandle,
  createAccountLedger,
  selectAccount,
  type AccountLedger,
  type Selector,
  type ServiceId,
} from './server.ts'
import { inMemoryDb, insertAccount, insertAgentGroup } from './testing.ts'

const handleA = accountHandle('google', 'a@work.example')
const handleB = accountHandle('google', 'b@work.example')

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
  ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
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
  for (const account of ['acc-a', 'acc-b', 'acc-c']) grant('g1', account, 'gmail')
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

describe('what the database refuses without the ledger', () => {
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
