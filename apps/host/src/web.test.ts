import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { account, connectionRequest } from '@kurumi/account/schema'
import { createAccountLedger } from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup, tokenGmailOnly } from '@kurumi/account/testing'
import { transaction } from '@kurumi/rpc/server'
import { eq } from 'drizzle-orm'

import { startWeb } from './web.ts'

const db = inMemoryDb()
const ledger = createAccountLedger({ db, vaultKey: randomBytes(32), webPort: 42331 })
let web: ReturnType<typeof startWeb> | undefined
afterEach(async () => {
  setSystemTime()
  await web?.stop(true)
  web = undefined
})

test('GET connects with a 302 and a second GET gives the used-link page', async () => {
  insertAgentGroup(db, 'web-work')
  ledger.connections.setClient({ clientId: 'test-client', clientSecret: 'test-secret' })
  const { url } = ledger.connections.connect(
    { agentGroupId: 'web-work', services: ['gmail'] },
    { kind: 'host' },
  )
  web = startWeb({ host: '127.0.0.1', port: 0 }, ledger)
  const local = new URL(new URL(url).pathname, web.url)
  const first = await fetch(local, { redirect: 'manual' })
  expect(first.status).toBe(302)
  const target = new URL(first.headers.get('location')!)
  expect(target.origin).toBe('https://accounts.google.com')
  expect(target.searchParams.get('scope')).toContain('https://mail.google.com/')
  expect(target.searchParams.get('code_challenge_method')).toBe('S256')
  expect(first.headers.get('cache-control')).toBe('no-store')
  expect(first.headers.get('referrer-policy')).toBe('no-referrer')
  const second = await fetch(local)
  expect(second.status).toBe(410)
  expect(await second.text()).toContain('run account connect again')
  expect((await fetch(new URL('/oauth/callback', web.url))).status).toBe(410)
  expect((await fetch(new URL('/rpc/status', web.url))).status).toBe(404)
  expect((await fetch(local, { method: 'POST' })).status).toBe(404)
})

test.each(['0.0.0.0', '::', 'localhost', '192.0.2.1'])('refuses to bind %s', (host) => {
  expect(() => startWeb({ host, port: 0 }, ledger)).toThrow('must bind 127.0.0.1')
})

test('a second link is refused after the client is configured again', async () => {
  insertAgentGroup(db, 'client-change')
  ledger.connections.setClient({ clientId: 'old-client', clientSecret: 'old-secret' })
  const id = ledger.connections.createRequest(
    { agentGroupId: 'client-change', services: ['gmail'] },
    { kind: 'host' },
  )
  const first = ledger.connections.issueLink(id, { kind: 'host' })
  const second = ledger.connections.issueLink(id, { kind: 'host' })
  web = startWeb({ host: '127.0.0.1', port: 0 }, ledger)
  expect((await fetch(new URL(`/connect/${first}`, web.url), { redirect: 'manual' })).status).toBe(
    302,
  )

  ledger.connections.setClient({ clientId: 'new-client', clientSecret: 'new-secret' })

  const refused = await fetch(new URL(`/connect/${second}`, web.url), { redirect: 'manual' })
  expect(refused.status).toBe(410)
  expect(await refused.text()).toContain('run account connect again')
  expect(db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get()!.state).toBe(
    'cancelled',
  )
})

test('the callback grants OAuth services and reloads the same uncached success page without exchanging again', async () => {
  insertAgentGroup(db, 'callback-work')
  let exchanges = 0
  const fetchImpl: typeof fetch = Object.assign(
    async () => {
      exchanges++
      return Response.json(tokenGmailOnly)
    },
    { preconnect: fetch.preconnect },
  )
  const callbackLedger = createAccountLedger({ db, vaultKey: randomBytes(32), fetch: fetchImpl })
  callbackLedger.connections.setClient({ clientId: 'client', clientSecret: 'secret' })
  const { url } = callbackLedger.connections.connect(
    { agentGroupId: 'callback-work', services: ['gmail', 'google-calendar'] },
    { kind: 'host' },
  )
  web = startWeb({ host: '127.0.0.1', port: 0 }, callbackLedger)
  const redirect = await fetch(new URL(new URL(url).pathname, web.url), { redirect: 'manual' })
  const state = new URL(redirect.headers.get('location')!).searchParams.get('state')!
  const callback = new URL(`/oauth/callback?state=${state}&code=fixture-code`, web.url)
  const first = await fetch(callback)
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toBe('no-store')
  expect(first.headers.get('referrer-policy')).toBe('no-referrer')
  expect(first.headers.get('content-type')).toContain('text/plain')
  const text = await first.text()
  expect(text).toContain('Connected. Granted: gmail.')
  expect(text).toContain('Not granted: google-calendar.')
  expect(await (await fetch(callback)).text()).toBe(text)
  expect(exchanges).toBe(1)
  expect((await fetch(callback, { method: 'POST' })).status).toBe(404)
})

test('invalid callback states all return the same refusal without reflecting query parameters', async () => {
  web = startWeb({ host: '127.0.0.1', port: 0 }, ledger)
  for (const query of [
    '',
    '?state=unknown&code=private-code',
    '?state=unknown&error=private-error',
  ]) {
    const response = await fetch(new URL(`/oauth/callback${query}`, web.url))
    expect(response.status).toBe(410)
    expect(await response.text()).toBe('This callback is unavailable. Run account connect again.')
  }
})

test.each(['access_denied', 'server_error', 'empty-grant'])(
  'the %s callback page names the outcome and retry action',
  async (outcome) => {
    const localDb = inMemoryDb()
    insertAgentGroup(localDb, 'work')
    const fetchImpl: typeof fetch = Object.assign(
      async () => Response.json({ ...tokenGmailOnly, scope: 'openid email' }),
      { preconnect: fetch.preconnect },
    )
    const localLedger = createAccountLedger({
      db: localDb,
      vaultKey: randomBytes(32),
      fetch: fetchImpl,
    })
    localLedger.connections.setClient({ clientId: 'client', clientSecret: 'secret' })
    const { url } = localLedger.connections.connect(
      { agentGroupId: 'work', services: ['gmail'] },
      { kind: 'host' },
    )
    web = startWeb({ host: '127.0.0.1', port: 0 }, localLedger)
    try {
      const redirect = await fetch(new URL(new URL(url).pathname, web.url), { redirect: 'manual' })
      const state = new URL(redirect.headers.get('location')!).searchParams.get('state')!
      const callback = new URL('/oauth/callback', web.url)
      callback.search = new URLSearchParams({
        state,
        ...(outcome === 'empty-grant' ? { code: 'fixture-code' } : { error: outcome }),
      }).toString()
      const response = await fetch(callback)
      const body = await response.text()
      expect(response.status).toBe(outcome === 'access_denied' ? 200 : 502)
      expect(body).toContain(
        outcome === 'access_denied'
          ? 'cancelled'
          : outcome === 'empty-grant'
            ? 'Nothing was granted'
            : 'connection failed',
      )
      expect(body).toContain('Run account connect again.')
      if (outcome !== 'access_denied') expect(body).not.toContain('cancelled')
      if (outcome === 'access_denied') expect(await (await fetch(callback)).text()).toBe(body)
    } finally {
      await web.stop(true)
      web = undefined
      localDb.$client.close()
    }
  },
)

test('shared-service refusal names the missing services and explains the next consent', async () => {
  const localDb = inMemoryDb()
  insertAgentGroup(localDb, 'work')
  insertAgentGroup(localDb, 'home')
  let full = true
  const localLedger = createAccountLedger({
    db: localDb,
    vaultKey: randomBytes(32),
    fetch: Object.assign(
      async () =>
        Response.json({
          ...tokenGmailOnly,
          scope: full
            ? `${tokenGmailOnly.scope} https://www.googleapis.com/auth/calendar`
            : tokenGmailOnly.scope,
        }),
      { preconnect: fetch.preconnect },
    ),
  })
  const connections = localLedger.connections
  connections.setClient({ clientId: 'fixture', clientSecret: 'fixture' })
  const begin = () => {
    const { url } = connections.connect(
      { agentGroupId: 'work', services: ['gmail'] },
      { kind: 'host' },
    )
    const result = connections.openLink(new URL(url).pathname.split('/').at(-1)!)
    if (result.kind !== 'authorize') throw new Error('missing authorize URL')
    return `/oauth/callback?state=${result.url.searchParams.get('state')}&code=fixture`
  }
  try {
    await connections.callback(new URL(begin(), 'http://127.0.0.1'))
    const held = localDb.select().from(account).get()!
    transaction(localDb, (tx) =>
      localLedger.grant(tx, {
        accountId: held.id,
        agentGroupId: 'home',
        service: 'google-calendar',
        grantedBy: 'host',
      }),
    )
    full = false
    const path = begin()
    web = startWeb({ host: '127.0.0.1', port: 0 }, localLedger)
    const response = await fetch(new URL(path, web.url))
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('google-calendar')
    expect(body).toContain('next consent will ask for these services')
    expect(body).toContain('only to the groups that already hold them')
    expect(body).toContain(
      'kurumi account connect --services gmail google-calendar --agent-group-id work',
    )
    expect(body).not.toContain('Press the card')
  } finally {
    await web?.stop(true)
    web = undefined
    localDb.$client.close()
  }
})

test('a past-due callback shows expiry without changing the request or exchanging code', async () => {
  insertAgentGroup(db, 'expired-work')
  ledger.connections.setClient({ clientId: 'fixture', clientSecret: 'fixture' })
  const id = ledger.connections.createRequest(
    { agentGroupId: 'expired-work', services: ['gmail'] },
    { kind: 'host' },
  )
  const opened = ledger.connections.openLink(ledger.connections.issueLink(id, { kind: 'host' }))
  if (opened.kind !== 'authorize') throw new Error('missing authorize URL')
  setSystemTime(Date.now() + 30 * 60_000)
  const before = db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get()
  web = startWeb({ host: '127.0.0.1', port: 0 }, ledger)
  const callback = new URL('/oauth/callback', web.url)
  callback.searchParams.set('state', opened.url.searchParams.get('state')!)
  callback.searchParams.set('code', 'fixture')
  const response = await fetch(callback)
  expect(response.status).toBe(410)
  expect(await response.text()).toBe('This request expired. Ask again to connect.')
  expect(db.select().from(connectionRequest).where(eq(connectionRequest.id, id)).get()).toEqual(
    before,
  )
})
