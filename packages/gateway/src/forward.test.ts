import { afterEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { once } from 'node:events'
import { request } from 'node:https'
import { createServer } from 'node:net'
import type { TLSSocket } from 'node:tls'

import {
  createAccountLedger,
  isInterceptedHost,
  type AuthMode,
  type CredentialPrincipal,
} from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'

import { credentialInject, pinnedLookup, type ForwardDeps } from './forward.ts'
import { startAgentPort } from './port.ts'
import { openTestTunnel, sendTestRequest, startFakeUpstream, startTestGateway } from './testing.ts'

const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
})

async function setup(options: Parameters<typeof startFakeUpstream>[0] = {}) {
  const upstream = await startFakeUpstream(options)
  stops.push(upstream.stop)
  const gateway = await startTestGateway({
    port: 0,
    token: 'test-token',
    intercepts: new Set(['fake.test']),
    upstream: upstream.destination,
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  return { upstream, gateway, tunnel }
}

test.each(['POST', 'DELETE'])(
  'the first %s upload chunk arrives before the client finishes its body',
  async (method) => {
    const received = Promise.withResolvers<void>()
    const { tunnel } = await setup({ onUploadChunk: () => received.resolve() })
    const response = Promise.withResolvers<string>()
    const client = request(
      {
        hostname: 'fake.test',
        port: 443,
        path: '/upload',
        method,
        agent: tunnel.agent,
        headers: { 'transfer-encoding': 'chunked' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', response.reject)
        res.on('end', () => response.resolve(Buffer.concat(chunks).toString()))
      },
    )
    client.on('error', response.reject)
    stops.push(() => {
      client.destroy()
    })
    const first = Buffer.alloc(64 * 1024, 97)
    client.write(first)
    await received.promise
    expect(client.writableEnded).toBe(false)
    client.end('last')
    const body: unknown = JSON.parse(await response.promise)
    expect(body).toEqual({
      bytes: first.length + 4,
      sha256: createHash('sha256').update(first).update('last').digest('hex'),
    })
  },
)

test.each(['GET', 'DELETE', 'OPTIONS'])(
  'a chunked %s body retains its bytes and digest',
  async (method) => {
    const { tunnel } = await setup()
    const response = await sendTestRequest(tunnel, {
      path: '/upload',
      method,
      headers: { 'transfer-encoding': 'chunked' },
      body: 'helloworld',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      bytes: 10,
      sha256: '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
    })
  },
)

test('body framing survives a client Connection nomination', async () => {
  const { tunnel } = await setup()
  const response = await sendTestRequest(tunnel, {
    path: '/upload',
    method: 'DELETE',
    headers: { 'content-length': '10', connection: 'content-length' },
    body: 'helloworld',
  })
  expect(JSON.parse(response.body)).toEqual({
    bytes: 10,
    sha256: '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
  })
})

test('a client cannot nominate a gateway-injected header for removal', async () => {
  const { upstream, tunnel } = await setup()
  const response = await sendTestRequest(tunnel, {
    path: '/echo',
    headers: { connection: 'x-injected', 'x-injected': 'client-value' },
  })
  expect(response.status).toBe(200)
  expect(upstream.requests[0]?.headers['x-injected']).toBe('yes')
})

test('a redirect and its body pass through without a second upstream request', async () => {
  const { upstream, tunnel } = await setup()
  upstream.setResponse('/redirect', {
    status: 302,
    body: 'moved',
    headers: { location: 'https://fake.test/echo' },
  })
  const response = await sendTestRequest(tunnel, { path: '/redirect' })
  expect(response.status).toBe(302)
  expect(response.headers.location).toBe('https://fake.test/echo')
  expect(response.body).toBe('moved')
  expect(upstream.requests.map((entry) => entry.path)).toEqual(['/redirect'])
})

test('an upstream 503 keeps its status and body', async () => {
  const { upstream, tunnel } = await setup()
  upstream.setResponse('/status', { status: 503, body: 'try later' })
  const response = await sendTestRequest(tunnel, { path: '/status' })
  expect(response.status).toBe(503)
  expect(response.body).toBe('try later')
})

test('an upstream Connection field with empty or invalid tokens cannot crash forwarding', async () => {
  const { upstream, tunnel } = await setup()
  upstream.setResponse('/connection', {
    status: 200,
    body: 'ok',
    headers: { connection: 'keep-alive, , bad token, x-hop', 'x-hop': 'remove', 'x-keep': 'keep' },
  })
  const response = await sendTestRequest(tunnel, { path: '/connection' })
  expect(response.status).toBe(200)
  expect(response.body).toBe('ok')
  expect(response.headers['x-hop']).toBeUndefined()
  expect(response.headers['x-keep']).toBe('keep')
})

test('an unknown-length response retains every byte', async () => {
  const { tunnel } = await setup()
  const response = await sendTestRequest(tunnel, { path: '/chunked?bytes=131073' })
  expect(response.status).toBe(200)
  expect(response.headers['content-length']).toBeUndefined()
  expect(response.body).toBe('x'.repeat(131073))
})

test('proxy credentials and connection-nominated headers do not reach upstream', async () => {
  const { upstream, tunnel } = await setup()
  await sendTestRequest(tunnel, {
    path: '/echo',
    headers: {
      'proxy-authorization': 'Basic inner-secret',
      'proxy-connection': 'keep-alive',
      connection: 'x-private',
      'x-private': 'remove-me',
      'x-end-to-end': 'keep-me',
    },
  })
  expect(upstream.requests[0]?.headers['proxy-authorization']).toBeUndefined()
  expect(upstream.requests[0]?.headers['proxy-connection']).toBeUndefined()
  expect(upstream.requests[0]?.headers['x-private']).toBeUndefined()
  expect(upstream.requests[0]?.headers['x-end-to-end']).toBe('keep-me')
})

test('a closed upstream returns host-bearing 502 JSON while the upload is unfinished', async () => {
  const { upstream, tunnel } = await setup()
  await upstream.stop()
  const response = Promise.withResolvers<{ status: number | undefined; body: string }>()
  const client = request(
    { hostname: 'fake.test', port: 443, path: '/upload', method: 'POST', agent: tunnel.agent },
    (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', response.reject)
      res.on('end', () =>
        response.resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      )
    },
  )
  client.on('error', response.reject)
  stops.push(() => {
    client.destroy()
  })
  client.write('first')
  const result = await response.promise
  expect(client.writableEnded).toBe(false)
  expect(result.status).toBe(502)
  expect(JSON.parse(result.body)).toEqual({ error: 'upstream_unreachable', host: 'fake.test' })
})

const groupSelector = 'sk-ant-kurumi-YW50aHJvcGlj'
const secrets = { main: 'sk-ant-api03-main-secret', second: 'sk-ant-oat01-second-secret' }

async function setupCredentials(forward: Partial<ForwardDeps<CredentialPrincipal>> = {}) {
  const db = inMemoryDb()
  insertAgentGroup(db, 'g1')
  const ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
  const upstream = await startFakeUpstream({ host: 'api.anthropic.com' })
  stops.push(upstream.stop)
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? { agentGroupId: 'g1' } : null),
    intercepts: isInterceptedHost,
    forward: { upstream: upstream.destination, inject: credentialInject(ledger), ...forward },
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
    target: { host: 'api.anthropic.com', port: 443 },
  })
  stops.push(tunnel.close)
  const addKey = (label: string, value: string, authMode: AuthMode = 'api-key') =>
    db.transaction((tx) =>
      ledger.addKey(tx, {
        vendor: 'anthropic',
        label,
        value,
        authMode,
        autoGrant: true,
      }),
    )
  const setDefault = (handle: string) =>
    db.transaction((tx) => {
      const found = ledger.accountIdOf(tx, handle)
      if (!found.ok) throw new Error(`no account ${handle}`)
      ledger.setDefault(tx, {
        agentGroupId: 'g1',
        accountId: found.accountId,
        service: 'anthropic-api',
      })
    })
  return { upstream, tunnel, addKey, setDefault }
}

async function exchangeRaw(socket: TLSSocket, bytes: string) {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  const closed = once(socket, 'close')
  socket.write(bytes)
  await closed
  const text = Buffer.concat(chunks).toString()
  const end = text.indexOf('\r\n\r\n')
  const [statusLine = '', ...lines] = text.slice(0, end).split('\r\n')
  return {
    status: Number(statusLine.split(' ')[1]),
    headers: Object.fromEntries(
      lines.map((line) => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
      }),
    ),
    body: text.slice(end + 4),
  }
}

const mentionsKurumi = (values: readonly string[]) =>
  values.filter((value) => /kurumi/i.test(value))

test.each([
  ['api-key', { 'x-api-key': groupSelector }, 'x-api-key', secrets.main, 'authorization'],
  [
    'oauth-token',
    { authorization: `Bearer ${groupSelector}` },
    'authorization',
    `Bearer ${secrets.main}`,
    'x-api-key',
  ],
] as const)(
  'an %s account reaches the upstream in its own slot and is named on the response',
  async (authMode, headers, slot, written, otherSlot) => {
    const { upstream, tunnel, addKey } = await setupCredentials()
    addKey('main', secrets.main, authMode)

    const response = await sendTestRequest(tunnel, { path: '/v1/models', headers })

    expect(response.status).toBe(200)
    expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.headers[slot]).toBe(written)
    expect(upstream.requests[0]?.headers[otherSlot]).toBeUndefined()
    expect(mentionsKurumi(upstream.requests[0]?.rawHeaders ?? [])).toEqual([])
  },
)

test('the account the upstream names is replaced by the one the gateway chose', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)
  upstream.setResponse('/v1/models', {
    status: 200,
    body: '{}',
    headers: { 'x-kurumi-account': 'anthropic/forged' },
  })

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
})

test('a group with no account is refused with a JSON 404 and nothing goes upstream', async () => {
  const { upstream, tunnel } = await setupCredentials()

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { 'x-api-key': groupSelector },
  })

  expect(response.status).toBe(404)
  expect(response.headers['content-type']).toBe('application/json')
  expect(response.headers['x-should-retry']).toBe('false')
  expect(response.headers['x-kurumi-gateway']).toBe('account_not_connected')
  expect(JSON.parse(response.body)).toEqual({
    error: 'account_not_connected',
    service: 'anthropic-api',
    next: expect.stringContaining('kurumi account add-key'),
  })
  expect(upstream.requests).toEqual([])
})

test('a credential refusal is decided before the upstream host is resolved', async () => {
  let resolved = 0
  const { tunnel } = await setupCredentials({
    upstream: undefined,
    resolve: () => {
      resolved++
      return Promise.reject(new Error('ENOTFOUND'))
    },
  })

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.status).toBe(404)
  expect(JSON.parse(response.body)).toMatchObject({ error: 'account_not_connected' })
  expect(resolved).toBe(0)
})

async function postToUnconnectedGroup(body: Buffer) {
  const { upstream, tunnel } = await setupCredentials()
  const response = Promise.withResolvers<{ status?: number; body: string }>()
  const client = request(
    {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      agent: tunnel.agent,
      headers: { 'content-length': String(body.length) },
    },
    (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', response.reject)
      res.on('end', () =>
        response.resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      )
    },
  )
  client.on('error', response.reject)
  client.end(body)
  return { ...(await response.promise), upstreamRequests: upstream.requests }
}

const uploadsToLoseTheResetRace = 10

test('a refused POST with a 16 MiB body still reads the JSON refusal', async () => {
  const body = Buffer.alloc(16 * 1024 * 1024, 97)
  for (let upload = 0; upload < uploadsToLoseTheResetRace; upload++) {
    const response = await postToUnconnectedGroup(body)

    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'account_not_connected' })
    expect(response.upstreamRequests).toEqual([])
  }
})

test('two accounts and no default are refused as ambiguous, listing both', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)
  addKey('second', secrets.second, 'oauth-token')

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.status).toBe(409)
  expect(JSON.parse(response.body)).toMatchObject({
    error: 'account_ambiguous',
    granted: ['anthropic/main', 'anthropic/second'],
  })
  expect(upstream.requests).toEqual([])
})

test('a named account wins over the default', async () => {
  const { upstream, tunnel, addKey, setDefault } = await setupCredentials()
  addKey('main', secrets.main)
  addKey('second', secrets.second, 'oauth-token')
  setDefault('anthropic/main')

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { 'x-api-key': 'sk-ant-kurumi-YW50aHJvcGljL3NlY29uZA' },
  })

  expect(response.headers['x-kurumi-account']).toBe('anthropic/second')
  expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${secrets.second}`)
})

test('the default serves a request that names no account', async () => {
  const { tunnel, addKey, setDefault } = await setupCredentials()
  addKey('main', secrets.main)
  addKey('second', secrets.second, 'oauth-token')
  setDefault('anthropic/second')

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { authorization: `Bearer ${groupSelector}` },
  })

  expect(response.status).toBe(200)
  expect(response.headers['x-kurumi-account']).toBe('anthropic/second')
})

test('two Authorization lines are refused as a duplicate slot before anything goes upstream', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await exchangeRaw(
    tunnel.socket,
    `GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer ${groupSelector}\r\nauthorization: Bearer other\r\nConnection: close\r\n\r\n`,
  )

  expect(response.status).toBe(400)
  expect(JSON.parse(response.body)).toEqual({
    error: 'duplicate_slot',
    service: 'anthropic-api',
    header: 'authorization',
    next: 'send the authorization header once',
  })
  expect(upstream.requests).toEqual([])
})

test('a refused WebSocket upgrade gets the same JSON response', async () => {
  const { upstream, tunnel } = await setupCredentials()

  const response = await exchangeRaw(
    tunnel.socket,
    `GET /v1/stream HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  )

  expect(response.status).toBe(404)
  expect(response.headers['content-type']).toBe('application/json')
  expect(response.headers['x-kurumi-gateway']).toBe('account_not_connected')
  expect(JSON.parse(response.body)).toMatchObject({ error: 'account_not_connected' })
  expect(upstream.requests).toEqual([])
})

test('a label outside Latin-1 is named percent-encoded and the request completes', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('日本', secrets.main)

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.status).toBe(200)
  expect(response.headers['x-kurumi-account']).toBe('anthropic/%E6%97%A5%E6%9C%AC')
  expect(upstream.requests).toHaveLength(1)
})

async function setupResolving(
  resolve: (host: string) => Promise<LookupAddress[]>,
  {
    host = 'localhost',
    addressRefusal,
    hostAddresses,
  }: Pick<ForwardDeps<unknown>, 'addressRefusal' | 'hostAddresses'> & {
    host?: string
  } = {},
) {
  let dials = 0
  const listener = createServer((socket) => {
    dials++
    socket.destroy()
  })
  listener.listen(0, '::')
  await once(listener, 'listening')
  stops.push(() => {
    listener.close()
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('listener has no TCP address')
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: () => ({}),
    intercepts: () => true,
    forward: {
      resolve,
      addressRefusal,
      hostAddresses,
      inject: ({ path, headers }) => ({ path, headers }),
    },
  })
  stops.push(gateway.stop)
  // The system resolver also answers localhost, so a gateway that ignored `resolve` would dial the listener.
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
    target: { host, port: address.port },
  })
  stops.push(tunnel.close)
  return { tunnel, dials: () => dials }
}

test.each([
  ['127.0.0.1', [{ address: '127.0.0.1', family: 4 }], 'loopback'],
  ['an IPv4-mapped private address', [{ address: '::ffff:a00:1', family: 6 }], 'private'],
  [
    'a public address and 127.0.0.1',
    [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    'loopback',
  ],
] satisfies [string, LookupAddress[], string][])(
  'an intercepted host resolving to %s is refused with a JSON 403 and never dialed',
  async (_name, addresses, reason) => {
    const { tunnel, dials } = await setupResolving(async () => addresses)

    const response = await sendTestRequest(tunnel, { path: '/v1/models' })

    expect(response.status).toBe(403)
    expect(response.headers['x-kurumi-gateway']).toBe('upstream_not_public')
    expect(JSON.parse(response.body)).toEqual({
      error: 'upstream_not_public',
      host: 'localhost',
      reason,
      next: `ask the owner to check the DNS answer for localhost on the kurumi host; it resolves to a ${reason} address, and kurumi forwards only to public addresses`,
    })
    expect(dials()).toBe(0)
  },
)

test('an intercepted host resolving to one of the host interface addresses is refused and never dialed', async () => {
  const { tunnel, dials } = await setupResolving(
    async () => [{ address: '203.0.113.7', family: 4 }],
    {
      hostAddresses: () => ['203.0.113.7'],
    },
  )

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.status).toBe(403)
  expect(JSON.parse(response.body)).toMatchObject({
    error: 'upstream_not_public',
    reason: 'host interface',
  })
  expect(dials()).toBe(0)
})

test('a WebSocket upgrade to an intercepted host resolving to loopback is refused', async () => {
  const { tunnel, dials } = await setupResolving(async () => [{ address: '127.0.0.1', family: 4 }])

  const response = await exchangeRaw(
    tunnel.socket,
    `GET /v1/stream HTTP/1.1\r\nHost: ${tunnel.target.host}:${tunnel.target.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  )

  expect(response.status).toBe(403)
  expect(response.headers['x-kurumi-gateway']).toBe('upstream_not_public')
  expect(JSON.parse(response.body)).toMatchObject({
    error: 'upstream_not_public',
    reason: 'loopback',
  })
  expect(dials()).toBe(0)
})

test('an intercepted host that fails to resolve gets the host-bearing 502 JSON and is never dialed', async () => {
  const { tunnel, dials } = await setupResolving(() => Promise.reject(new Error('ENOTFOUND')))

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(response.status).toBe(502)
  expect(JSON.parse(response.body)).toEqual({ error: 'upstream_unreachable', host: 'localhost' })
  expect(dials()).toBe(0)
})

test.each([
  ['fails to resolve', () => Promise.reject(new Error('ENOTFOUND'))],
  ['resolves to no address', async () => []],
] satisfies [string, (host: string) => Promise<LookupAddress[]>][])(
  'a 16 MiB POST to an intercepted host that %s still reads the 502 JSON and is never dialed',
  async (_name, resolve) => {
    const body = 'a'.repeat(16 * 1024 * 1024)
    for (let upload = 0; upload < uploadsToLoseTheResetRace; upload++) {
      const { tunnel, dials } = await setupResolving(resolve)

      const response = await sendTestRequest(tunnel, { method: 'POST', path: '/v1/messages', body })

      expect(response.status).toBe(502)
      expect(JSON.parse(response.body)).toEqual({
        error: 'upstream_unreachable',
        host: 'localhost',
      })
      expect(dials()).toBe(0)
    }
  },
)

test('a forwarded request dials only the pinned address, resolved once', async () => {
  let resolved = 0
  const { tunnel, dials } = await setupResolving(
    async () => {
      resolved++
      return [{ address: '127.0.0.1', family: 4 }]
    },
    { host: 'pinned.invalid', addressRefusal: () => null },
  )

  await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(dials()).toBe(1)
  expect(resolved).toBe(1)
})

const checked = [
  { address: '2606:4700:4700::1111', family: 6 },
  { address: '93.184.215.14', family: 4 },
]

function lookupOnce(addresses: LookupAddress[], all: boolean) {
  let answer:
    | { error: Error | null; address: string | LookupAddress[]; family?: number }
    | undefined
  pinnedLookup(addresses)('api.anthropic.com', { all }, (error, address, family) => {
    answer = { error, address, family }
  })
  return answer
}

test('a pinned single lookup answers the first checked address and its family', () => {
  expect(lookupOnce(checked, false)).toEqual({
    error: null,
    address: '2606:4700:4700::1111',
    family: 6,
  })
})

test('a pinned lookup for all addresses answers every checked address', () => {
  expect(lookupOnce(checked, true)).toEqual({ error: null, address: checked, family: undefined })
})

test('a pinned lookup over no address fails', () => {
  expect(lookupOnce([], false)?.error).toBeInstanceOf(Error)
})
