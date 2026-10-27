import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { serviceIds, vendorOf } from './catalog.ts'
import { createConnections, parseConnectionRequest } from './connect.ts'
import { ConnectInputSchema } from './contract.ts'
import { account, connectionRequest, connectLink, oauthClient } from './schema.ts'
import { storedAccounts, storedConnections } from './server.ts'
import { inMemoryDb, insertAccount, insertAgentGroup } from './testing.ts'
import { open } from './vault.ts'

let db: ReturnType<typeof inMemoryDb>
const vaultKey = randomBytes(32)
let connections: ReturnType<typeof createConnections>
const caller = { kind: 'host' } as const
const input = {
  agentGroupId: 'work',
  services: ['gmail', 'google-calendar', 'gmail'] as ('gmail' | 'google-calendar')[],
}

beforeEach(() => {
  db = inMemoryDb()
  insertAgentGroup(db, 'work')
  connections = createConnections({ db, vaultKey, webPort: 42331 })
  connections.setClient({ clientId: 'test-client', clientSecret: 'test-secret' })
})

afterEach(() => {
  setSystemTime()
  db.$client.close()
})

const create = () => connections.createRequest(input, caller)
function authorize(token: string): URL {
  const result = connections.openLink(token)
  expect(result.kind).toBe('authorize')
  if (result.kind !== 'authorize') throw new Error('expected authorize URL')
  return result.url
}

test('connect accepts every Google service in the catalog and refuses other vendors', () => {
  for (const service of serviceIds) {
    expect(
      ConnectInputSchema.safeParse({ agentGroupId: 'work', services: [service] }).success,
    ).toBe(vendorOf(service) === 'google')
  }
})

test('a link works once and stores only its hash and issuing principal', () => {
  const id = create()
  const token = connections.issueLink(id, caller)
  expect(token).toHaveLength(43)
  const row = db.select().from(connectLink).get()!
  expect(row.tokenHash).not.toBe(token)
  expect(row.tokenHash).toHaveLength(64)
  expect(row.mintedFor).toBe('host')
  expect(row.usedAt).toBeNull()
  authorize(token)
  expect(connections.openLink(token)).toEqual({ kind: 'unavailable' })
  expect(db.select().from(connectLink).get()!.usedAt).toBeInstanceOf(Date)
})

test.each([299_999, 300_000, 300_001])(
  'a link opened %d ms after issuance obeys the five-minute limit',
  (elapsed) => {
    const issuedAt = Date.UTC(2026, 9, 28)
    setSystemTime(issuedAt)
    const token = connections.issueLink(create(), caller)
    setSystemTime(issuedAt + elapsed)
    expect(connections.openLink(token).kind).toBe(elapsed < 300_000 ? 'authorize' : 'unavailable')
    expect(db.select().from(connectLink).get()!.usedAt).toEqual(
      elapsed < 300_000 ? new Date(issuedAt + elapsed) : null,
    )
  },
)

test('two links share the full authorize URL, persisted state and sealed verifier across restart', () => {
  const id = create()
  const first = connections.issueLink(id, caller)
  const second = connections.issueLink(id, caller)
  const url = authorize(first)
  connections = createConnections({ db, vaultKey, webPort: 42331 })
  expect(authorize(second).href).toBe(url.href)
  const row = db.select().from(connectionRequest).get()!
  const request = parseConnectionRequest(row)
  expect(request.state).toBe('authorizing')
  expect(url.searchParams.get('state')).toBe(row.oauthState)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('include_granted_scopes')).toBe('true')
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:42331/oauth/callback')
  expect(url.searchParams.get('scope')!.split(' ')).toEqual([
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/calendar',
    'openid',
    'email',
  ])
  const verifier = open(vaultKey, id, row.pkceVerifier!)
  expect(row.pkceVerifier!.toString()).not.toContain(verifier)
  expect(new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')).toBe(
    url.searchParams.get('code_challenge')!,
  )
})

test('the partial unique index admits only one live request per session and vendor', () => {
  const id = connections.createRequest({ ...input, sessionId: 'session-1' }, caller)
  expect(() => connections.createRequest({ ...input, sessionId: 'session-1' }, caller)).toThrow(
    'UNIQUE',
  )
  authorize(connections.issueLink(id, caller))
  expect(() => connections.createRequest({ ...input, sessionId: 'session-1' }, caller)).toThrow(
    'UNIQUE',
  )
  connections.createRequest({ ...input, sessionId: 'session-2' }, caller)
  create()
  create()
  db.update(connectionRequest).set({ state: 'cancelled' }).where(eq(connectionRequest.id, id)).run()
  connections.createRequest({ ...input, sessionId: 'session-1' }, caller)
})

test('only group approvers may create requests or mint links, and agents never may', () => {
  const id = create()
  connections = createConnections({
    db,
    vaultKey,
    canApprove: (who, group) => who.kind === 'human' && who.userId === 'owner' && group === 'work',
  })
  for (const who of [
    { kind: 'human', userId: 'member' },
    { kind: 'agent', agentGroupId: 'work', sessionId: 's' },
  ] as const) {
    expect(() => connections.createRequest(input, who)).toThrow('only an approver')
    expect(() => connections.issueLink(id, who)).toThrow('only an approver')
  }
  connections.issueLink(id, { kind: 'human', userId: 'owner' })
  expect(db.select().from(connectLink).get()!.mintedFor).toBe('human:owner')
})

test('malformed tokens, terminal requests, and expired requests cannot consume a link', () => {
  const id = create()
  const token = connections.issueLink(id, caller)
  expect(connections.openLink('bad')).toEqual({ kind: 'unavailable' })
  db.update(connectionRequest).set({ state: 'cancelled' }).where(eq(connectionRequest.id, id)).run()
  expect(connections.openLink(token)).toEqual({ kind: 'unavailable' })
  expect(() => connections.issueLink(id, caller)).toThrow('again')
  const next = create()
  const fresh = connections.issueLink(next, caller)
  db.update(connectionRequest)
    .set({ expiresAt: new Date(0) })
    .where(eq(connectionRequest.id, next))
    .run()
  expect(connections.openLink(fresh)).toEqual({ kind: 'unavailable' })
  expect(
    db
      .select()
      .from(connectLink)
      .all()
      .every((row) => row.usedAt === null),
  ).toBe(true)
})

test('client and pending verifiers participate in vault key protection before any account exists', () => {
  const client = db.select().from(oauthClient).get()!
  expect(client.material.toString()).not.toContain('test-client')
  expect(client.material.toString()).not.toContain('test-secret')
  expect(storedAccounts(db).count).toBe(0)
  expect(storedConnections(db).count).toBe(1)
  authorize(connections.issueLink(create(), caller))
  const stored = storedConnections(db)
  expect(stored.count).toBe(2)
  expect(stored.unopenedBy(vaultKey)).toEqual([])
  expect(stored.unopenedBy(randomBytes(32))).toHaveLength(2)
})

test.each(['completed', 'expired', 'cancelled', 'past-deadline'] as const)(
  'a damaged verifier on a %s request does not need the vault key at startup',
  (state) => {
    const id = create()
    authorize(connections.issueLink(id, caller))
    db.update(connectionRequest)
      .set({
        pkceVerifier: Buffer.of(0),
        ...(state === 'past-deadline' ? { expiresAt: new Date() } : { state }),
      })
      .where(eq(connectionRequest.id, id))
      .run()
    expect(storedConnections(db).unopenedBy(vaultKey)).toEqual([])
  },
)

test('bad inputs and missing groups or clients leave no request or link', () => {
  expect(() => connections.connect({ ...input, agentGroupId: 'missing' }, caller)).toThrow(
    'not found',
  )
  expect(ConnectInputSchema.safeParse({ ...input, services: ['github'] }).success).toBe(false)
  db.delete(oauthClient).run()
  expect(() => connections.connect(input, caller)).toThrow('set-client')
  expect(db.select().from(connectionRequest).all()).toEqual([])
  expect(db.select().from(connectLink).all()).toEqual([])
})

test('a contradictory stored request fails parsing instead of being authorized', () => {
  create()
  const row = db.select().from(connectionRequest).get()!
  expect(() => parseConnectionRequest({ ...row, state: 'authorizing' })).toThrow(
    'invalid connection',
  )
})

test('a completed request remains readable after its account is removed', () => {
  const id = create()
  const token = connections.issueLink(id, caller)
  authorize(token)
  insertAccount(db, {
    id: 'acc-connected',
    vendor: 'google',
    label: 'connected',
    services: ['gmail'],
  })
  db.update(connectionRequest)
    .set({ state: 'completed', accountId: 'acc-connected' })
    .where(eq(connectionRequest.id, id))
    .run()
  db.delete(account).where(eq(account.id, 'acc-connected')).run()
  const request = parseConnectionRequest(db.select().from(connectionRequest).get()!)
  expect(request.state).toBe('completed')
  expect(request.accountId).toBeNull()
  expect(connections.openLink(token)).toEqual({ kind: 'unavailable' })
  expect(() => connections.issueLink(id, caller)).toThrow('again')
})

test('setting a client cancels open and authorizing requests without changing terminal requests', () => {
  const pending = create()
  const pendingLink = connections.issueLink(pending, caller)
  const started = create()
  const first = connections.issueLink(started, caller)
  const second = connections.issueLink(started, caller)
  authorize(first)
  const terminal = create()
  db.update(connectionRequest)
    .set({ state: 'expired' })
    .where(eq(connectionRequest.id, terminal))
    .run()

  connections.setClient({ clientId: 'new-client', clientSecret: 'new-secret' })

  expect(connections.openLink(pendingLink)).toEqual({ kind: 'unavailable' })
  expect(connections.openLink(second)).toEqual({ kind: 'unavailable' })
  expect(
    db
      .select()
      .from(connectionRequest)
      .all()
      .map(({ state }) => state),
  ).toEqual(['cancelled', 'cancelled', 'expired'])
  expect(authorize(connections.issueLink(create(), caller)).searchParams.get('client_id')).toBe(
    'new-client',
  )
})

test('a failed cancellation rolls back the client replacement', () => {
  const id = create()
  const first = connections.issueLink(id, caller)
  const second = connections.issueLink(id, caller)
  const original = authorize(first)
  db.$client.run(`CREATE TRIGGER refuse_cancel BEFORE UPDATE ON connection_request
    WHEN NEW.state = 'cancelled' BEGIN SELECT RAISE(ABORT, 'cannot cancel'); END`)

  expect(() =>
    connections.setClient({ clientId: 'new-client', clientSecret: 'new-secret' }),
  ).toThrow('cannot cancel')

  expect(authorize(second).href).toBe(original.href)
})
