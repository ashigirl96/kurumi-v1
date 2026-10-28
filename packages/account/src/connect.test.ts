import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { transaction } from '@kurumi/rpc/server'
import { eq, sql } from 'drizzle-orm'

import { serviceIds, vendorOf } from './catalog.ts'
import { parseConnectionRequest, type createConnections } from './connect.ts'
import { ConnectInputSchema } from './contract.ts'
import { tokenFull, tokenGmailOnly } from './fixtures/google/token-responses.ts'
import {
  account,
  accountGrant,
  connectionRequest,
  connectLink,
  defaultAccount,
  oauthClient,
} from './schema.ts'
import { createAccountLedger, storedAccounts, storedConnections } from './server.ts'
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
  connections = makeConnections({ db, vaultKey, webPort: 42331 })
  connections.setClient({ clientId: 'test-client', clientSecret: 'test-secret' })
})

afterEach(() => {
  setSystemTime()
  db.$client.close()
})

const makeConnections = (deps: Parameters<typeof createAccountLedger>[0]) =>
  createAccountLedger(deps).connections

const create = () => connections.createRequest(input, caller)
function authorize(token: string): URL {
  const result = connections.openLink(token)
  expect(result.kind).toBe('authorize')
  if (result.kind !== 'authorize') throw new Error('expected authorize URL')
  return result.url
}

test('connect validates catalog services and names supported services for other vendors', () => {
  for (const service of serviceIds) {
    expect(
      ConnectInputSchema.safeParse({ agentGroupId: 'work', services: [service] }).success,
    ).toBe(true)
    if (vendorOf(service) !== 'google')
      expect(() =>
        connections.createRequest({ services: [service], agentGroupId: 'work' }, caller),
      ).toThrow('gmail と google-calendar')
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
  connections = makeConnections({ db, vaultKey, webPort: 42331 })
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

test('only group approvers may create CLI requests or mint links', () => {
  const id = create()
  connections = makeConnections({
    db,
    vaultKey,
    canApprove: (who, group) => who.kind === 'human' && who.userId === 'owner' && group === 'work',
  })
  for (const who of [{ kind: 'human', userId: 'member' }] as const) {
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
  expect(() => connections.createRequest({ ...input, services: ['github'] }, caller)).toThrow(
    'gmail と google-calendar',
  )
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

function tokenEndpoint(
  reply: (form: URLSearchParams) => Response | Promise<Response>,
  log?: Parameters<typeof createAccountLedger>[0]['log'],
  approval: Pick<Parameters<typeof createAccountLedger>[0], 'canApprove'> = {},
) {
  let exchanges = 0
  const fetchImpl: typeof fetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(db.$client.inTransaction).toBe(false)
      exchanges++
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      return reply(new URLSearchParams(await new Request(_url, init).text()))
    },
    { preconnect: fetch.preconnect },
  )
  const ledger = createAccountLedger({
    db,
    vaultKey,
    webPort: 42331,
    fetch: fetchImpl,
    log,
    ...approval,
  })
  connections = ledger.connections
  return { ledger, exchanges: () => exchanges }
}

function callbackUrl(id = create(), query = 'code=fixture-code'): URL {
  const url = authorize(connections.issueLink(id, caller))
  return new URL(
    `http://127.0.0.1:42331/oauth/callback?state=${url.searchParams.get('state')}&${query}`,
  )
}

test('completion seals tokens, grants covered requested services, injects the access token and survives reload', async () => {
  const upstream = tokenEndpoint((form) => {
    expect(form.get('code')).toBe('fixture-code')
    expect(form.get('client_id')).toBe('test-client')
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:42331/oauth/callback')
    expect(form.get('code_verifier')).toHaveLength(43)
    return Response.json(tokenFull)
  })
  const url = callbackUrl()
  const page = await connections.callback(url)
  expect(page).toEqual({ kind: 'completed', granted: ['gmail', 'google-calendar'], missing: [] })
  const held = db.select().from(account).get()!
  expect(held.kind).toBe('oauth')
  expect(held.subject).toBe('100000000000000000001')
  expect(held.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now())
  expect(held.material.toString()).not.toContain(tokenFull.access_token)
  expect(held.material.toString()).not.toContain(tokenFull.refresh_token)
  expect(JSON.parse(open(vaultKey, held.id, held.material))).toMatchObject({
    kind: 'oauth',
    accessToken: tokenFull.access_token,
    refreshToken: tokenFull.refresh_token,
  })
  expect(
    db
      .select()
      .from(accountGrant)
      .all()
      .map(({ service }) => service),
  ).toEqual(['gmail', 'google-calendar'])
  expect(upstream.ledger.candidates('work', 'gmail')).toHaveLength(1)
  const credential = await upstream.ledger.credentialFor(
    { agentGroupId: 'work' },
    {
      host: 'gmail.googleapis.com',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
      headers: new Headers(),
      rawHeaders: [],
    },
  )
  expect(credential.kind).toBe('inject')
  if (credential.kind !== 'inject') throw new Error('expected OAuth injection')
  expect(credential.injection.apply().headers.get('authorization')).toBe(
    `Bearer ${tokenFull.access_token}`,
  )
  expect(() => JSON.stringify(credential.injection)).toThrow('cannot be serialized')
  connections = makeConnections({ db, vaultKey, webPort: 42331 })
  expect(await connections.callback(url)).toEqual(page)
  expect(upstream.exchanges()).toBe(1)
  expect(db.select().from(connectionRequest).get()!.pkceVerifier).toBeNull()
})

test('a Gmail-only exchange reports missing Calendar and grants only Gmail', async () => {
  const { ledger } = tokenEndpoint(() => Response.json(tokenGmailOnly))
  expect(await connections.callback(callbackUrl())).toEqual({
    kind: 'completed',
    granted: ['gmail'],
    missing: ['google-calendar'],
  })
  expect(db.select().from(account).get()!.services).toEqual(['gmail'])
  expect(ledger.candidates('work', 'google-calendar')).toEqual([])
})

test('access_denied cancels without exchanging or opening a damaged verifier', async () => {
  const endpoint = tokenEndpoint(() => {
    throw new Error('must not exchange')
  })
  const id = create()
  const url = callbackUrl(id, 'error=access_denied')
  db.update(connectionRequest)
    .set({ pkceVerifier: Buffer.of(0) })
    .where(eq(connectionRequest.id, id))
    .run()
  expect(await connections.callback(url)).toEqual({ kind: 'cancelled' })
  expect(db.select().from(connectionRequest).get()!.state).toBe('cancelled')
  expect(db.select().from(account).all()).toEqual([])
  expect(endpoint.exchanges()).toBe(0)
  expect(await connections.callback(url)).toEqual({ kind: 'cancelled' })
})

test.each(['unknown', 'expired', 'cancelled', 'open', 'missing-code', 'duplicate-state'] as const)(
  '%s callbacks do not exchange a code',
  async (mode) => {
    const endpoint = tokenEndpoint(() => Response.json(tokenFull))
    const id = create()
    const url = callbackUrl(id)
    if (mode === 'unknown') url.searchParams.set('state', 'unknown')
    if (mode === 'expired')
      db.update(connectionRequest)
        .set({ expiresAt: new Date(0) })
        .run()
    if (mode === 'cancelled')
      connections.setClient({ clientId: 'changed', clientSecret: 'changed' })
    if (mode === 'open')
      db.update(connectionRequest)
        .set({ state: 'open', oauthState: null, pkceVerifier: null })
        .run()
    if (mode === 'missing-code') url.searchParams.delete('code')
    if (mode === 'duplicate-state') url.searchParams.append('state', url.searchParams.get('state')!)
    const page = await connections.callback(url)
    expect(endpoint.exchanges()).toBe(0)
    expect(page).toEqual({
      kind: mode === 'cancelled' ? 'cancelled' : 'unavailable',
    })
    expect(db.select().from(account).all()).toEqual([])
  },
)

test.each(['success', 'failure'] as const)(
  'the losing tab discards a late %s and shows the completed state',
  async (outcome) => {
    const delayed = Promise.withResolvers<Response>()
    const endpoint = tokenEndpoint((form) =>
      form.get('code') === 'late-code' ? delayed.promise : Response.json(tokenFull),
    )
    const url = callbackUrl()
    const lateUrl = new URL(url)
    lateUrl.searchParams.set('code', 'late-code')
    const late = connections.callback(lateUrl)
    const winner = await connections.callback(url)
    delayed.resolve(
      outcome === 'success'
        ? Response.json(tokenGmailOnly)
        : Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    expect(await late).toEqual(winner)
    expect(db.select().from(account).get()!.services).toEqual(['gmail', 'google-calendar'])
    expect(db.select().from(account).all()).toHaveLength(1)
    expect(endpoint.exchanges()).toBe(2)
  },
)

test.each(['client-change', 'expires'] as const)(
  'an exchange in flight cannot complete after %s',
  async (mode) => {
    const delayed = Promise.withResolvers<Response>()
    tokenEndpoint(() => delayed.promise)
    const pending = connections.callback(callbackUrl())
    if (mode === 'client-change')
      connections.setClient({ clientId: 'changed', clientSecret: 'changed' })
    else
      db.update(connectionRequest)
        .set({ expiresAt: new Date(0) })
        .run()
    delayed.resolve(Response.json(tokenFull))
    expect(await pending).toEqual({
      kind: mode === 'client-change' ? 'cancelled' : 'unavailable',
    })
    expect(db.select().from(account).all()).toEqual([])
    expect(db.select().from(accountGrant).all()).toEqual([])
  },
)

test('reconnecting upserts the same subject and removes grants/defaults no longer covered', async () => {
  let response = tokenFull
  const { ledger } = tokenEndpoint(() => Response.json(response))
  await connections.callback(callbackUrl())
  const id = db.select().from(account).get()!.id
  transaction(db, (tx) =>
    ledger.setDefault(tx, { agentGroupId: 'work', accountId: id, service: 'google-calendar' }),
  )
  response = tokenGmailOnly
  await connections.callback(callbackUrl())
  expect(db.select().from(account).all()).toHaveLength(1)
  expect(db.select().from(account).get()!.id).toBe(id)
  expect(
    db
      .select()
      .from(accountGrant)
      .all()
      .map(({ service }) => service),
  ).toEqual(['gmail'])
  expect(db.select().from(defaultAccount).all()).toEqual([])
})

test.each(['exchange', 'identity', 'validation'] as const)(
  'a failed %s resets to a parseable open request without partial writes',
  async (failure) => {
    tokenEndpoint(() =>
      failure === 'exchange'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({
            ...tokenFull,
            ...(failure === 'identity' ? { id_token: null } : {}),
            ...(failure === 'validation' ? { access_token: '' } : {}),
          }),
    )
    const url = callbackUrl()
    expect(await connections.callback(url)).toEqual({ kind: 'failed' })
    const request = parseConnectionRequest(db.select().from(connectionRequest).get()!)
    expect(request.state).toBe('open')
    expect(request.oauthState).toBeNull()
    expect(request.pkceVerifier).toBeNull()
    expect(db.select().from(account).all()).toEqual([])
    expect(db.select().from(accountGrant).all()).toEqual([])
    expect(await connections.callback(url)).toEqual({ kind: 'unavailable' })
    authorize(connections.issueLink(request.id, caller))
  },
)

test('reloading during exchange shares the single-use code instead of racing invalid_grant', async () => {
  const delayed = Promise.withResolvers<Response>()
  const endpoint = tokenEndpoint(() =>
    endpoint.exchanges() === 1
      ? delayed.promise
      : Response.json({ error: 'invalid_grant' }, { status: 400 }),
  )
  const url = callbackUrl()
  const original = connections.callback(url)
  const reloaded = connections.callback(url)
  expect(endpoint.exchanges()).toBe(1)
  delayed.resolve(Response.json(tokenFull))
  expect(await original).toEqual({
    kind: 'completed',
    granted: ['gmail', 'google-calendar'],
    missing: [],
  })
  expect(await reloaded).toEqual(await original)
  expect(db.select().from(account).all()).toHaveLength(1)
  expect(db.select().from(connectionRequest).get()!.state).toBe('completed')
})

test.each(['success', 'failure'] as const)(
  'a failed tab leaves a second exchange to settle with %s',
  async (outcome) => {
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    tokenEndpoint((form) => (form.get('code') === 'fixture-code' ? first.promise : second.promise))
    const id = create()
    const url = callbackUrl(id)
    const otherUrl = callbackUrl(id, 'code=second-code')
    expect(otherUrl.searchParams.get('state')).toBe(url.searchParams.get('state'))
    const tabA = connections.callback(url)
    const tabB = connections.callback(otherUrl)
    first.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    expect(await tabA).toEqual({ kind: 'failed' })
    expect(db.select().from(connectionRequest).get()!.state).toBe('authorizing')
    second.resolve(
      outcome === 'success'
        ? Response.json(tokenFull)
        : Response.json({ error: 'server_error' }, { status: 500 }),
    )
    expect(await tabB).toEqual(
      outcome === 'success'
        ? { kind: 'completed', granted: ['gmail', 'google-calendar'], missing: [] }
        : { kind: 'failed' },
    )
    expect(db.select().from(account).all()).toHaveLength(outcome === 'success' ? 1 : 0)
    expect(db.select().from(connectionRequest).get()!.state).toBe(
      outcome === 'success' ? 'completed' : 'open',
    )
  },
)

test.each(['admin_policy_enforced', 'server_error', 'temporarily_unavailable', ''])(
  'provider error %s fails without cancelling or exchanging',
  async (error) => {
    const endpoint = tokenEndpoint(() => Response.json(tokenFull))
    expect(await connections.callback(callbackUrl(create(), `error=${error}`))).toEqual({
      kind: 'failed',
    })
    expect(db.select().from(connectionRequest).get()!.state).toBe('open')
    expect(db.select().from(account).all()).toEqual([])
    expect(endpoint.exchanges()).toBe(0)
  },
)

test.each(['success', 'failure'] as const)(
  'a losing tab after cancellation shows the cancel page for a late %s',
  async (outcome) => {
    const delayed = Promise.withResolvers<Response>()
    const endpoint = tokenEndpoint(() => delayed.promise)
    const url = callbackUrl()
    const pending = connections.callback(url)
    const cancel = new URL(url)
    cancel.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      error: 'access_denied',
    }).toString()
    const page = await connections.callback(cancel)
    expect(page).toEqual({ kind: 'cancelled' })
    delayed.resolve(
      outcome === 'success'
        ? Response.json(tokenFull)
        : Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    expect(await pending).toEqual(page)
    expect(await connections.callback(cancel)).toEqual(page)
    expect(endpoint.exchanges()).toBe(1)
    expect(db.select().from(account).all()).toEqual([])
    db.update(connectionRequest)
      .set({ expiresAt: new Date(0) })
      .run()
    expect(await connections.callback(cancel)).toEqual({ kind: 'unavailable' })
  },
)

test.each(['new', 'reconnect'] as const)(
  'consent covering no requested services leaves a %s account untouched and the request retryable',
  async (mode) => {
    let response = tokenFull
    const { ledger } = tokenEndpoint(() => Response.json(response))
    if (mode === 'reconnect') await connections.callback(callbackUrl())
    const before = db.select().from(account).all()
    const grants = db.select().from(accountGrant).all()
    response = { ...tokenFull, scope: 'openid https://www.googleapis.com/auth/calendar' }
    const id = connections.createRequest({ agentGroupId: 'work', services: ['gmail'] }, caller)
    expect(await connections.callback(callbackUrl(id))).toEqual({ kind: 'nothing-granted' })
    expect(db.select().from(account).all()).toEqual(before)
    expect(db.select().from(accountGrant).all()).toEqual(grants)
    expect(ledger.candidates('work', 'gmail')).toHaveLength(mode === 'reconnect' ? 1 : 0)
    expect(
      db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get()!.state,
    ).toBe('open')
  },
)

test('reconnecting without a new refresh token keeps the stored refresh token', async () => {
  let response: Omit<typeof tokenFull, 'refresh_token'> & { refresh_token?: string } = tokenFull
  tokenEndpoint(() => Response.json(response))
  await connections.callback(callbackUrl())
  const { refresh_token: _refreshToken, ...withoutRefreshToken } = tokenGmailOnly
  response = withoutRefreshToken
  expect(await connections.callback(callbackUrl())).toEqual({
    kind: 'completed',
    granted: ['gmail'],
    missing: ['google-calendar'],
  })
  const held = db.select().from(account).get()!
  expect(JSON.parse(open(vaultKey, held.id, held.material))).toMatchObject({
    accessToken: tokenGmailOnly.access_token,
    refreshToken: tokenFull.refresh_token,
  })
})

test.each([
  ['exchange', 'invalid_grant'],
  ['identity', 'missing_id_token'],
  ['validation', 'unexpected_response'],
] as const)('a failed %s logs only the request id and reason', async (failure, reason) => {
  const events: unknown[] = []
  tokenEndpoint(
    () =>
      failure === 'exchange'
        ? Response.json(
            { error: 'invalid_grant', error_description: 'private-code' },
            { status: 400 },
          )
        : Response.json({
            ...tokenFull,
            ...(failure === 'identity' ? { id_token: null } : { access_token: '' }),
          }),
    (event) => events.push(event),
  )
  const id = create()
  expect(await connections.callback(callbackUrl(id))).toEqual({ kind: 'failed' })
  expect(events).toEqual([{ kind: 'account.connect.failed', requestId: id, reason }])
})

test('a conflicting account label logs the error name and propagates without partial writes', async () => {
  const events: unknown[] = []
  tokenEndpoint(
    () => Response.json(tokenFull),
    (event) => events.push(event),
  )
  insertAccount(db, {
    id: 'other',
    vendor: 'google',
    label: 'alice@example.com',
    services: ['gmail'],
  })
  db.update(account).set({ subject: 'different-subject' }).run()
  const before = db.select().from(account).all()
  const id = create()
  const failure = await connections.callback(callbackUrl(id)).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: 'SQLiteError',
    message: expect.stringContaining('UNIQUE constraint failed'),
  })
  expect(events).toEqual([{ kind: 'account.connect.failed', requestId: id, reason: 'SQLiteError' }])
  expect(db.select().from(account).all()).toEqual(before)
  expect(db.select().from(accountGrant).all()).toEqual([])
  expect(db.select().from(connectionRequest).get()!.state).toBe('authorizing')
})

test('a code bug is logged by name and is not converted to the retryable failure page', async () => {
  const events: unknown[] = []
  tokenEndpoint(
    () => {
      throw new TypeError('private detail')
    },
    (event) => events.push(event),
  )
  const id = create()
  const failure = await connections.callback(callbackUrl(id)).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(TypeError)
  expect(events).toEqual([{ kind: 'account.connect.failed', requestId: id, reason: 'TypeError' }])
})

const agentCaller = { kind: 'agent', agentGroupId: 'work', sessionId: 'ses-work' } as const
function withCards(
  deps: Partial<Parameters<typeof createAccountLedger>[0]> = {},
  receipt: 'queued' | 'duplicate' | 'no_session' = 'queued',
) {
  db.run(sql`CREATE TABLE test_card (id TEXT PRIMARY KEY, session_id TEXT, content TEXT)`)
  db.run(sql`CREATE TABLE test_notice (id TEXT PRIMARY KEY, session_id TEXT, content TEXT)`)
  const delivered: string[] = []
  const resumed: string[] = []
  connections = makeConnections({
    db,
    vaultKey,
    ...deps,
    cards: {
      post(tx, sessionId, card) {
        expect(db.$client.inTransaction).toBe(true)
        const id = `card-${card.ref}`
        tx.run(sql`INSERT INTO test_card VALUES (${id}, ${sessionId}, ${JSON.stringify(card)})`)
        return id
      },
      replace(tx, messageId, card) {
        expect(db.$client.inTransaction).toBe(true)
        const original = tx.all<{ session_id: string }>(
          sql`SELECT session_id FROM test_card WHERE id = ${messageId}`,
        )[0]
        if (!original) throw new Error('missing card')
        const id = `replace-${card.ref}`
        tx.run(
          sql`INSERT INTO test_card VALUES (${id}, ${original.session_id}, ${JSON.stringify({ ...card, replaces: messageId })})`,
        )
        return id
      },
      queueNotice(tx, notice) {
        if (receipt !== 'queued') return receipt
        expect(db.$client.inTransaction).toBe(true)
        tx.run(
          sql`INSERT INTO test_notice VALUES (${notice.key}, ${notice.sessionId}, ${notice.text})`,
        )
        return 'queued'
      },
      deliverNotice(notice) {
        expect(db.$client.inTransaction).toBe(false)
        resumed.push(notice.key)
      },
      async deliver(id) {
        expect(db.$client.inTransaction).toBe(false)
        delivered.push(id)
      },
    },
  })
  return {
    delivered,
    resumed,
    cards: () => db.all<{ content: string }>(sql`SELECT content FROM test_card`),
    notices: () =>
      db.all<{ id: string; session_id: string; content: string }>(sql`SELECT * FROM test_notice`),
  }
}

test('agent connect binds the authenticated group and session, reuses the request and posts one URL-free card', async () => {
  const proof = withCards()
  const result = await connections.connectAgent(
    { services: ['gmail'], agentGroupId: 'forged' },
    agentCaller,
  )
  const reused = await connections.connectAgent({ services: ['gmail', 'gmail'] }, agentCaller)
  expect(reused).toEqual({ ...result, reused: true })
  expect(result).toMatchObject({ kind: 'card_posted', reused: false })
  expect(JSON.stringify(reused)).not.toContain('http')
  expect(JSON.stringify(result)).not.toContain('http')
  expect(proof.cards()).toHaveLength(1)
  expect(proof.cards()[0]?.content).toContain('work')
  expect(proof.cards()[0]?.content).not.toContain('http')
  expect(db.select().from(connectionRequest).get()).toMatchObject({
    id: result.requestId,
    agentGroupId: 'work',
    sessionId: 'ses-work',
    cardMessageId: `card-${result.requestId}`,
  })
  expect(db.select().from(connectLink).all()).toEqual([])
})

test('agent connect expires overdue requests and cancels a live request when services change', async () => {
  withCards()
  const first = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
  const second = await connections.connectAgent(
    { services: ['gmail', 'google-calendar'] },
    agentCaller,
  )
  expect(second.requestId).not.toBe(first.requestId)
  expect(
    db.select().from(connectionRequest).where(eq(connectionRequest.id, first.requestId)).get()
      ?.state,
  ).toBe('cancelled')
  db.update(connectionRequest)
    .set({ expiresAt: new Date(0) })
    .where(eq(connectionRequest.id, second.requestId))
    .run()
  const third = await connections.connectAgent(
    { services: ['gmail', 'google-calendar'] },
    agentCaller,
  )
  expect(third.requestId).not.toBe(second.requestId)
  expect(
    db.select().from(connectionRequest).where(eq(connectionRequest.id, second.requestId)).get()
      ?.state,
  ).toBe('expired')
})

test('failed card insertion rolls the request back', async () => {
  withCards()
  db.run(
    sql`CREATE TRIGGER refuse_card BEFORE INSERT ON test_card BEGIN SELECT RAISE(ABORT, 'card failed'); END`,
  )
  const failure = await connections
    .connectAgent({ services: ['gmail'] }, agentCaller)
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(db.select().from(connectionRequest).all()).toEqual([])
})

test('press refuses non-approvers, CLI-only refs, unknown refs, bad actions and expired or terminal requests without links', async () => {
  withCards({ canApprove: (who, group) => who.kind === 'host' && group === 'work' })
  const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
  const press = (
    ref: string,
    action = 'connect',
    who: Parameters<typeof connections.press>[1] = caller,
  ) => connections.press({ ref, action }, who)
  expect(press(requestId, 'connect', { kind: 'human', userId: 'member' })).toEqual({
    kind: 'notice',
    text: 'この group の承認者だけが接続できます',
  })
  expect(press(requestId, 'connect', agentCaller).kind).toBe('notice')
  const unavailable = {
    kind: 'notice',
    text: 'このカードは利用できません。もう一度接続を頼んでください',
  } satisfies ReturnType<typeof connections.press>
  expect(press(create())).toEqual(unavailable)
  expect(press('unknown')).toEqual(unavailable)
  expect(press(requestId, 'forged')).toEqual(unavailable)
  for (const state of ['cancelled', 'completed', 'expired'] as const) {
    db.update(connectionRequest).set({ state }).where(eq(connectionRequest.id, requestId)).run()
    expect(press(requestId)).toEqual(unavailable)
  }
  db.update(connectionRequest)
    .set({ state: 'open', expiresAt: new Date(0) })
    .where(eq(connectionRequest.id, requestId))
    .run()
  expect(press(requestId)).toEqual(unavailable)
  expect(db.select().from(connectLink).all()).toEqual([])
})

test('a human approver’s card link grants only to the card group and records the approver', async () => {
  withCards({
    canApprove: (who) => who.kind === 'human' && who.userId === 'owner',
    fetch: Object.assign(async () => Response.json(tokenFull), { preconnect: fetch.preconnect }),
  })
  insertAgentGroup(db, 'home')
  const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
  const reply = connections.press(
    { ref: requestId, action: 'connect' },
    { kind: 'human', userId: 'owner' },
  )
  if (reply.kind !== 'private-link') throw new Error('missing private link')
  const url = authorize(new URL(reply.url).pathname.split('/').at(-1)!)
  expect(
    await connections.callback(
      new URL(
        `http://127.0.0.1/oauth/callback?state=${url.searchParams.get('state')}&code=fixture-code`,
      ),
    ),
  ).toMatchObject({ kind: 'completed' })
  expect(db.select().from(accountGrant).all()).toMatchObject([
    { agentGroupId: 'work', service: 'gmail', grantedBy: 'human:owner' },
  ])
})

test('a second approver restarts consent, completes as themselves and invalidates the first state', async () => {
  const exchanges: string[] = []
  withCards({
    canApprove: (who) => who.kind === 'human',
    fetch: Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        exchanges.push(new URLSearchParams(await new Request(_url, init).text()).get('code') ?? '')
        return Response.json(tokenGmailOnly)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
  const pressAs = (userId: string) => {
    const reply = connections.press(
      { ref: requestId, action: 'connect' },
      { kind: 'human', userId },
    )
    if (reply.kind !== 'private-link') throw new Error('missing link')
    return authorize(new URL(reply.url).pathname.split('/').at(-1)!)
  }
  const first = pressAs('a')
  const other = pressAs('b')
  expect(other.searchParams.get('state')).not.toBe(first.searchParams.get('state'))
  expect(other.searchParams.get('code_challenge')).not.toBe(
    first.searchParams.get('code_challenge'),
  )
  expect(pressAs('b').href).toBe(other.href)
  const callback = (url: URL, code: string) =>
    connections.callback(
      new URL(
        `http://127.0.0.1/oauth/callback?state=${url.searchParams.get('state')}&code=${code}`,
      ),
    )
  expect(await callback(other, 'code-b')).toMatchObject({ kind: 'completed' })
  expect(db.select().from(accountGrant).all()).toMatchObject([
    { agentGroupId: 'work', service: 'gmail', grantedBy: 'human:b' },
  ])
  expect(await callback(first, 'late-code-a')).toEqual({ kind: 'unavailable' })
  expect(exchanges).toEqual(['code-b'])
})

test('reconnect requests all held services but grants only the services asked for', async () => {
  tokenEndpoint(() => Response.json(tokenFull))
  await connections.callback(callbackUrl())
  const held = db.select().from(account).get()!
  db.update(account).set({ status: 'needs_reauth' }).run()
  db.delete(accountGrant).run()
  db.insert(accountGrant)
    .values({
      accountId: held.id,
      agentGroupId: 'work',
      vendor: 'google',
      service: 'gmail',
      grantedBy: 'host',
      grantedAt: new Date(),
    })
    .run()
  const id = connections.createRequest({ services: ['gmail'], agentGroupId: 'work' }, caller)
  const url = authorize(connections.issueLink(id, caller))
  expect(url.searchParams.get('scope')).toContain('calendar')
  await connections.callback(
    new URL(
      `http://127.0.0.1/oauth/callback?state=${url.searchParams.get('state')}&code=fixture-code`,
    ),
  )
  expect(
    db
      .select()
      .from(accountGrant)
      .all()
      .map(({ service }) => service),
  ).toEqual(['gmail'])
})

test('narrow consent explains the shared services and widens only OAuth for a successful retry', async () => {
  let reply = tokenFull
  tokenEndpoint(() => Response.json(reply))
  await connections.callback(callbackUrl())
  insertAgentGroup(db, 'home')
  const held = db.select().from(account).get()!
  db.delete(accountGrant).run()
  db.insert(accountGrant)
    .values({
      accountId: held.id,
      agentGroupId: 'home',
      vendor: 'google',
      service: 'google-calendar',
      grantedBy: 'host',
      grantedAt: new Date(),
    })
    .run()
  const before = db.select().from(accountGrant).all()
  reply = tokenGmailOnly
  const id = connections.createRequest({ services: ['gmail'], agentGroupId: 'work' }, caller)
  expect(await connections.callback(callbackUrl(id))).toEqual({
    kind: 'shared-services-missing',
    services: ['google-calendar'],
  })
  expect(db.select().from(accountGrant).all()).toEqual(before)
  expect(db.select().from(account).get()).toEqual(held)
  expect(
    db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get(),
  ).toMatchObject({
    state: 'open',
    services: ['gmail'],
    oauthServices: ['gmail', 'google-calendar'],
    oauthState: null,
    pkceVerifier: null,
    authorizedBy: null,
  })
  const url = authorize(connections.issueLink(id, caller))
  expect(url.searchParams.get('scope')).toContain('calendar')
  reply = tokenFull
  expect(
    await connections.callback(
      new URL(
        `http://127.0.0.1/oauth/callback?state=${url.searchParams.get('state')}&code=full-code`,
      ),
    ),
  ).toEqual({ kind: 'completed', granted: ['gmail'], missing: [] })
  expect(db.select().from(accountGrant).all()).toMatchObject([
    { agentGroupId: 'home', service: 'google-calendar' },
    { agentGroupId: 'work', service: 'gmail' },
  ])
})

test('reconnect includes a needs_reauth account held for a different service', async () => {
  tokenEndpoint(() => Response.json(tokenFull))
  await connections.callback(callbackUrl())
  db.update(account).set({ status: 'needs_reauth' }).run()
  db.delete(accountGrant).where(eq(accountGrant.service, 'gmail')).run()
  const id = connections.createRequest({ services: ['gmail'], agentGroupId: 'work' }, caller)
  expect(authorize(connections.issueLink(id, caller)).searchParams.get('scope')).toContain(
    'calendar',
  )
  expect(
    db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get()?.services,
  ).toEqual(['gmail'])
})

test('a reconnect updates requested grant audit to the approver whose link completes it', async () => {
  const endpoint = tokenEndpoint(() => Response.json(tokenFull), undefined, {
    canApprove: () => true,
  })
  await connections.callback(callbackUrl())
  const before = db.select().from(accountGrant).all()
  expect(before.every((row) => row.grantedBy === 'host')).toBe(true)
  const id = create()
  const other = makeConnections({ db, vaultKey, canApprove: () => true })
  const opened = other.openLink(other.issueLink(id, { kind: 'human', userId: 'new-owner' }))
  if (opened.kind !== 'authorize') throw new Error('missing authorize URL')
  const state = opened.url.searchParams.get('state')
  expect(
    await connections.callback(
      new URL(`http://127.0.0.1/oauth/callback?state=${state}&code=next-code`),
    ),
  ).toMatchObject({ kind: 'completed' })
  expect(endpoint.exchanges()).toBe(2)
  expect(
    db
      .select()
      .from(accountGrant)
      .all()
      .every((row) => row.grantedBy === 'human:new-owner'),
  ).toBe(true)
})

test.each(['completed', 'cancelled'] as const)(
  'a %s callback replaces and resumes once, including concurrent callbacks and reload',
  async (outcome) => {
    const proof = withCards({
      fetch: Object.assign(async () => Response.json(tokenGmailOnly), {
        preconnect: fetch.preconnect,
      }),
    })
    const { requestId } = await connections.connectAgent(
      { services: ['gmail', 'google-calendar'] },
      agentCaller,
    )
    const url = callbackUrl(
      requestId,
      outcome === 'cancelled' ? 'error=access_denied' : 'code=fixture-code',
    )
    const pages = await Promise.all([connections.callback(url), connections.callback(url)])
    expect(pages[0]?.kind).toBe(outcome)
    expect(pages[1]).toEqual(pages[0])
    expect(await connections.callback(url)).toEqual(pages[0])
    expect(proof.cards()).toHaveLength(2)
    const replacement = JSON.parse(proof.cards()[1]!.content)
    expect(replacement).toMatchObject({
      ref: requestId,
      replaces: `card-${requestId}`,
      body: '',
      buttons: [],
    })
    expect(replacement.title).toBe(
      outcome === 'completed'
        ? '✅ google/alice@example.com を work につなぎました（gmail）'
        : '接続をキャンセルしました',
    )
    expect(proof.notices()).toEqual([
      {
        id: requestId,
        session_id: agentCaller.sessionId,
        content:
          outcome === 'completed'
            ? 'Account google/alice@example.com is now connected for gmail. Continue the task that needed it.'
            : 'The approver cancelled the account connection. Do not retry without their request.',
      },
    ])
    expect(proof.resumed).toEqual([requestId])
    expect(proof.delivered).toEqual([`card-${requestId}`, `replace-${requestId}`])
  },
)

test.each(['code=fixture-code', 'error=access_denied'])(
  'CLI completion or cancellation writes no chat rows: %s',
  async (query) => {
    const proof = withCards({
      fetch: Object.assign(async () => Response.json(tokenGmailOnly), {
        preconnect: fetch.preconnect,
      }),
    })
    await connections.callback(callbackUrl(create(), query))
    expect(proof.cards()).toEqual([])
    expect(proof.notices()).toEqual([])
    expect(proof.resumed).toEqual([])
  },
)

test.each(['completed', 'cancelled'] as const)(
  'a failed notice insert rolls %s, grants, and replacement back together',
  async (outcome) => {
    const proof = withCards({
      fetch: Object.assign(async () => Response.json(tokenGmailOnly), {
        preconnect: fetch.preconnect,
      }),
    })
    const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
    db.run(
      sql`CREATE TRIGGER refuse_notice BEFORE INSERT ON test_notice BEGIN SELECT RAISE(ABORT, 'notice failed'); END`,
    )
    const failure = await connections
      .callback(
        callbackUrl(
          requestId,
          outcome === 'cancelled' ? 'error=access_denied' : 'code=fixture-code',
        ),
      )
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(db.select().from(connectionRequest).get()?.state).toBe('authorizing')
    expect(db.select().from(account).all()).toEqual([])
    expect(db.select().from(accountGrant).all()).toEqual([])
    expect(proof.cards()).toHaveLength(1)
    expect(proof.notices()).toEqual([])
    expect(proof.resumed).toEqual([])
  },
)

test.each(['failed', 'nothing-granted', 'shared-services-missing'] as const)(
  'retryable %s leaves the card and session alone',
  async (outcome) => {
    const proof = withCards({
      fetch: Object.assign(
        async () =>
          Response.json(outcome === 'failed' ? { error: 'invalid_grant' } : tokenGmailOnly, {
            status: outcome === 'failed' ? 400 : 200,
          }),
        { preconnect: fetch.preconnect },
      ),
    })
    if (outcome === 'shared-services-missing') {
      insertAgentGroup(db, 'home')
      insertAccount(db, {
        id: 'shared',
        vendor: 'google',
        label: 'alice@example.com',
        services: ['gmail', 'google-calendar'],
      })
      db.update(account).set({ subject: '100000000000000000001' }).run()
      db.insert(accountGrant)
        .values({
          accountId: 'shared',
          agentGroupId: 'home',
          vendor: 'google',
          service: 'google-calendar',
          grantedBy: 'host',
          grantedAt: new Date(),
        })
        .run()
    }
    const { requestId } = await connections.connectAgent(
      { services: [outcome === 'nothing-granted' ? 'google-calendar' : 'gmail'] },
      agentCaller,
    )
    expect((await connections.callback(callbackUrl(requestId))).kind).toBe(outcome)
    expect(proof.cards()).toHaveLength(1)
    expect(proof.notices()).toEqual([])
    expect(proof.resumed).toEqual([])
  },
)

test.each(['open', 'authorizing'] as const)(
  'complete accepts the current approver for an %s request and tags terminal requests',
  async (state) => {
    withCards({ canApprove: (who) => who.kind === 'human' && who.userId === 'owner' })
    const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
    insertAccount(db, { id: 'existing', vendor: 'google', label: 'fixture', services: ['gmail'] })
    if (state === 'authorizing') {
      const link = connections.issueLink(requestId, { kind: 'human', userId: 'owner' })
      connections.openLink(link)
    }
    db.update(connectionRequest).set({ authorizedBy: 'human:stale' }).run()
    for (const who of [agentCaller, { kind: 'human', userId: 'member' }] as const) {
      expect(() =>
        transaction(db, (tx) => connections.complete(tx, requestId, 'existing', who)),
      ).toThrow('only an approver')
      expect(db.select().from(accountGrant).all()).toEqual([])
    }
    const result = transaction(db, (tx) =>
      connections.complete(tx, requestId, 'existing', { kind: 'human', userId: 'owner' }),
    )
    expect(result.kind).toBe('completed')
    expect(db.select().from(accountGrant).get()?.grantedBy).toBe('human:owner')
    expect(db.select().from(connectionRequest).get()?.authorizedBy).toBe('human:owner')
    for (const terminal of ['completed', 'cancelled', 'expired'] as const) {
      db.update(connectionRequest).set({ state: terminal }).run()
      expect(
        transaction(db, (tx) => connections.complete(tx, requestId, 'existing', caller)),
      ).toEqual({ kind: 'nothing-to-complete' })
    }
    db.update(connectionRequest)
      .set({
        state: 'open',
        oauthState: null,
        pkceVerifier: null,
        accountId: null,
        expiresAt: new Date(0),
      })
      .run()
    expect(
      transaction(db, (tx) => connections.complete(tx, requestId, 'existing', caller)),
    ).toEqual({ kind: 'nothing-to-complete' })
    expect(
      transaction(db, (tx) => connections.complete(tx, 'missing', 'existing', caller)),
    ).toEqual({ kind: 'nothing-to-complete' })
  },
)

test('a completed CLI request is distinguishable from nothing to complete', () => {
  const id = create()
  insertAccount(db, { id: 'existing', vendor: 'google', label: 'fixture', services: ['gmail'] })
  expect(transaction(db, (tx) => connections.complete(tx, id, 'existing', caller))).toEqual({
    kind: 'completed',
    delivery: null,
  })
  expect(transaction(db, (tx) => connections.complete(tx, id, 'existing', caller))).toEqual({
    kind: 'nothing-to-complete',
  })
})

test.each(['duplicate', 'no_session'] as const)(
  'completion does not deliver a notice for a %s receipt',
  async (receipt) => {
    const proof = withCards({}, receipt)
    const { requestId } = await connections.connectAgent({ services: ['gmail'] }, agentCaller)
    insertAccount(db, { id: 'existing', vendor: 'google', label: 'fixture', services: ['gmail'] })
    const result = transaction(db, (tx) => connections.complete(tx, requestId, 'existing', caller))
    if (result.kind !== 'completed') throw new Error('did not complete')
    expect(result.delivery?.noticeReceipt).toBe(receipt)
    connections.deliverCompletion(result.delivery)
    expect(proof.resumed).toEqual([])
    expect(proof.notices()).toEqual([])
  },
)
