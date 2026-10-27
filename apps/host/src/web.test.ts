import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { connectionRequest } from '@kurumi/account/schema'
import { createAccountLedger } from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'
import { eq } from 'drizzle-orm'

import { startWeb } from './web.ts'

const db = inMemoryDb()
const ledger = createAccountLedger({ db, vaultKey: randomBytes(32), webPort: 42331 })
let web: ReturnType<typeof startWeb> | undefined
afterEach(async () => {
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
  expect((await fetch(new URL('/oauth/callback', web.url))).status).toBe(404)
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
