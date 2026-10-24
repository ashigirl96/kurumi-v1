import { afterEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request } from 'node:https'
import { createServer } from 'node:net'
import type { TLSSocket } from 'node:tls'

import {
  accountHandle,
  createAccountLedger,
  isInterceptedHost,
  type AuthMode,
  type CredentialPrincipal,
} from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'

import {
  credentialInject,
  pinnedLookup,
  type ConnectTarget,
  type EgressEvent,
  type ForwardDeps,
} from './forward.ts'
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

async function setupCredentials({
  target = { host: 'api.anthropic.com', port: 443 },
  ...forward
}: Partial<ForwardDeps<CredentialPrincipal>> & { target?: ConnectTarget } = {}) {
  const db = inMemoryDb()
  insertAgentGroup(db, 'g1')
  const ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
  const upstream = await startFakeUpstream({ host: target.host })
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
    target,
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
  return { upstream, tunnel, addKey, setDefault, containerEnv: () => ledger.containerEnv('g1') }
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
    headers: { 'x-kurumi-account': 'anthropic/forged', x_kurumi_account: 'anthropic/forged' },
  })

  const response = await sendTestRequest(tunnel, { path: '/v1/models' })

  expect(accountHeaders(response.headers)).toEqual([['x-kurumi-account', 'anthropic/main']])
})

const accountHeaders = (headers: IncomingHttpHeaders) =>
  Object.entries(headers).filter(([name]) => name.replaceAll('_', '-') === 'x-kurumi-account')

test.each(['x-kurumi-account', 'X_Kurumi_Account'])(
  'an upstream %s on a request kurumi passes untouched never reaches the client',
  async (name) => {
    const { upstream, tunnel } = await setupCredentials({
      target: { host: 'www.googleapis.com', port: 443 },
    })
    upstream.setResponse('/discovery/v1/apis', {
      status: 200,
      body: '{}',
      headers: { [name]: 'google/forged' },
    })

    const response = await sendTestRequest(tunnel, { path: '/discovery/v1/apis' })

    expect(response.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(accountHeaders(response.headers)).toEqual([])
  },
)

const slotLines = (rawHeaders: readonly string[]) =>
  rawHeaders.flatMap((name, index) =>
    index % 2 === 0 &&
    ['authorization', 'x-api-key'].includes(name.toLowerCase().replaceAll('_', '-'))
      ? [[name, rawHeaders[index + 1]]]
      : [],
  )

test.each([
  [
    'Authorization',
    'api-key',
    { 'x-api-key': groupSelector, authorization: 'Bearer sk-ant-oat01-client-own' },
    ['x-api-key', secrets.main],
  ],
  [
    'Authorization',
    'oauth-token',
    { 'x-api-key': groupSelector, authorization: 'Bearer sk-ant-oat01-client-own' },
    ['authorization', `Bearer ${secrets.main}`],
  ],
  [
    'x_api_key',
    'oauth-token',
    { x_api_key: groupSelector },
    ['authorization', `Bearer ${secrets.main}`],
  ],
  [
    'x-api-key',
    'oauth-token',
    { 'x-api-key': 'sk-ant-api03-client-own' },
    ['authorization', `Bearer ${secrets.main}`],
  ],
] as const)(
  'the container own %s never reaches the upstream beside an %s account',
  async (_header, authMode, headers, injected) => {
    const { upstream, tunnel, addKey } = await setupCredentials()
    addKey('main', secrets.main, authMode)

    const response = await sendTestRequest(tunnel, { path: '/v1/models', headers })

    expect(response.status).toBe(200)
    expect(slotLines(upstream.requests[0]?.rawHeaders ?? [])).toEqual([[...injected]])
  },
)

test('a container spawned before its oauth-token key reaches the upstream as an OAuth request', async () => {
  const { upstream, tunnel, addKey, containerEnv } = await setupCredentials()
  const env = containerEnv()
  expect(Object.keys(env)).toEqual(['ANTHROPIC_API_KEY'])
  addKey('main', secrets.second, 'oauth-token')

  const response = await sendTestRequest(tunnel, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: '{}',
  })

  expect(response.status).toBe(200)
  expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
  expect(upstream.requests[0]?.headers).toMatchObject({
    authorization: `Bearer ${secrets.second}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
  expect(upstream.requests[0]?.headers['x-api-key']).toBeUndefined()
})

test('a container spawned for an oauth-token key reaches a later api-key default without the OAuth beta', async () => {
  const { upstream, tunnel, addKey, setDefault, containerEnv } = await setupCredentials()
  addKey('subscription', secrets.second, 'oauth-token')
  const env = containerEnv()
  expect(Object.keys(env)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  addKey('main', secrets.main)
  setDefault('anthropic/main')

  const response = await sendTestRequest(tunnel, {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ''}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: '{}',
  })

  expect(response.status).toBe(200)
  expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
  expect(upstream.requests[0]?.headers['x-api-key']).toBe(secrets.main)
  expect(upstream.requests[0]?.headers.authorization).toBeUndefined()
  expect(upstream.requests[0]?.headers['anthropic-beta']).toBeUndefined()
})

test('an intercepted host on a port other than 443 is refused before any account is chosen', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials({
    target: { host: 'api.anthropic.com', port: 8443 },
  })
  addKey('main', secrets.main)

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { 'x-api-key': groupSelector },
  })

  expect(response.status).toBe(403)
  expect(JSON.parse(response.body)).toEqual({
    error: 'port_not_allowed',
    host: 'api.anthropic.com',
    port: 8443,
    next: 'connect to api.anthropic.com on port 443; kurumi serves it on no other port',
  })
  expect(upstream.requests).toEqual([])
})

test('a TRACE to a credentialed host is refused with 405 and nothing goes upstream', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await sendTestRequest(tunnel, {
    method: 'TRACE',
    path: '/v1/models',
    headers: { 'x-api-key': groupSelector },
  })

  expect(response.status).toBe(405)
  expect(response.headers.allow).toBe('GET, HEAD, POST, PUT, PATCH, DELETE')
  expect(JSON.parse(response.body)).toMatchObject({ error: 'method_not_allowed', method: 'TRACE' })
  expect(upstream.requests).toEqual([])
})

test('a group with no account is refused with a JSON 403 and nothing goes upstream', async () => {
  const { upstream, tunnel } = await setupCredentials()

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { 'x-api-key': groupSelector },
  })

  expect(response.status).toBe(403)
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

  expect(response.status).toBe(403)
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

    expect(response.status).toBe(403)
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

  expect(response.status).toBe(403)
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

function connectStatus(port: number, path: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path,
      headers: { 'Proxy-Authorization': `Basic ${Buffer.from('s:test-token').toString('base64')}` },
    })
    req.on('error', reject)
    req.on('connect', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode)
    })
    req.end()
  })
}

async function until(condition: () => boolean) {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error('condition never held')
    await Bun.sleep(5)
  }
}

async function setupLogged(options: { target?: ConnectTarget } = {}) {
  const events: EgressEvent<CredentialPrincipal>[] = []
  const credentials = await setupCredentials({ ...options, log: (event) => events.push(event) })
  return { ...credentials, events }
}

test('an injected request is logged with its account, service, status, and a path without the query', async () => {
  const { tunnel, addKey, events } = await setupLogged()
  addKey('main', secrets.main)
  const response = await sendTestRequest(tunnel, {
    path: '/v1/messages?beta=true&key=kurumi:anthropic/main',
    method: 'POST',
    headers: { 'x-api-key': groupSelector },
    body: '{"secret":"request body"}',
  })
  expect(response.status).toBe(200)
  await until(() => events.length === 1)
  expect(events[0]).toEqual({
    decision: 'injected',
    account: accountHandle('anthropic', 'main'),
    service: 'anthropic-api',
    principal: { agentGroupId: 'g1' },
    at: expect.any(Number),
    host: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    durationMs: expect.any(Number),
  })
})

test('a refused request is logged with its code and service, never the selector it carried', async () => {
  const { tunnel, addKey, events } = await setupLogged()
  addKey('main', secrets.main)
  const written = 'kurumi:anthropic/nobody-granted'
  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { 'x-api-key': written },
  })
  expect(response.status).toBe(403)
  await until(() => events.length === 1)
  expect(events[0]).toMatchObject({
    decision: 'refused',
    refusal: 'account_not_granted',
    service: 'anthropic-api',
    status: 403,
  })
  expect(JSON.stringify(events)).not.toContain('nobody-granted')
  expect(JSON.stringify(events)).not.toContain(secrets.main)
})

test('a request to an intercepted host whose path names no service is logged as passed', async () => {
  const { tunnel, events } = await setupLogged({
    target: { host: 'www.googleapis.com', port: 443 },
  })
  const response = await sendTestRequest(tunnel, { path: '/drive/v3/files' })
  expect(response.status).toBe(200)
  await until(() => events.length === 1)
  expect(events[0]).toMatchObject({ decision: 'passed', status: 200, path: '/drive/v3/files' })
  expect(events[0]).not.toHaveProperty('account')
})

test('an intercepted host on another port is logged as refused with no service', async () => {
  const { tunnel, events } = await setupLogged({
    target: { host: 'api.anthropic.com', port: 8443 },
  })
  const response = await sendTestRequest(tunnel, { path: '/v1/models' })
  expect(response.status).toBe(403)
  await until(() => events.length === 1)
  expect(events[0]).toMatchObject({
    decision: 'refused',
    refusal: 'port_not_allowed',
    service: null,
    status: 403,
  })
})

test('a passthrough CONNECT to a non-public address is logged as refused', async () => {
  const events: EgressEvent<{ agentGroupId: string }>[] = []
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? { agentGroupId: 'g1' } : null),
    intercepts: () => false,
    resolve: async () => [{ address: '127.0.0.2', family: 4 }],
    hostAddresses: () => [],
    forward: {
      inject: ({ path, headers }) => ({ path, headers }),
      log: (event) => events.push(event),
    },
  })
  stops.push(gateway.stop)
  const status = await connectStatus(gateway.port, 'private.test:443')
  expect(status).toBe(403)
  expect(events).toEqual([
    {
      decision: 'refused',
      refusal: 'upstream_not_public',
      service: null,
      principal: { agentGroupId: 'g1' },
      at: expect.any(Number),
      host: 'private.test',
      method: 'CONNECT',
      path: 'private.test:443',
      status: 403,
      durationMs: expect.any(Number),
    },
  ])
})
