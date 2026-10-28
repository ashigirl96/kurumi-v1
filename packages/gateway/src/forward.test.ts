import { afterEach, describe, expect, jest, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { getEventListeners, once } from 'node:events'
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http'
import { Agent, createServer as createHttpsServer, request } from 'node:https'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { connect, type TLSSocket } from 'node:tls'

import {
  accountHandle,
  createAccountLedger,
  isInterceptedHost,
  type CredentialPrincipal,
} from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { pinnedLookup } from './address.ts'
import type { EgressPrincipal } from './egress-log.ts'
import {
  credentialInject,
  forward,
  forwardUpgrade,
  type ConnectTarget,
  type EgressEvent,
  type ForwardDeps,
} from './forward.ts'
import {
  ALLOWANCE_MS,
  createEgressApproval,
  MAX_HELD_BODY_BYTES,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_PER_GROUP,
  MAX_UNDECIDED_PER_GROUP,
  type EgressApproval,
  type GatewayApprovals,
  type SessionNotice,
} from './hold.ts'
import { startAgentPort } from './port.ts'
import { egressAllowance } from './schema.ts'
import { migrations } from './server.ts'
import {
  createCertificateAuthority,
  openTestTunnel,
  sendTestRequest,
  startFakeUpstream,
  startTestGateway,
} from './testing.ts'

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
  ...deps
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
    forward: { upstream: upstream.destination, inject: credentialInject(ledger), ...deps },
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
    target,
  })
  stops.push(tunnel.close)
  const addKey = (label: string, value: string) =>
    db.transaction((tx) =>
      ledger.addKey(tx, {
        vendor: 'anthropic',
        label,
        value,
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
  return { upstream, tunnel, addKey, setDefault, containerEnv: () => ledger.containerEnv() }
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
  ['Authorization', { authorization: `Bearer ${groupSelector}` }],
  ['x-api-key', { 'x-api-key': groupSelector }],
] as const)(
  'an Anthropic account named in %s reaches the upstream as a bearer and is named on the response',
  async (_header, headers) => {
    const { upstream, tunnel, addKey } = await setupCredentials()
    addKey('main', secrets.main)

    const response = await sendTestRequest(tunnel, {
      path: '/v1/models',
      headers,
    })

    expect(response.status).toBe(200)
    expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${secrets.main}`)
    expect(upstream.requests[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(slotLines(upstream.requests[0]?.rawHeaders ?? [])).toEqual([
      ['authorization', `Bearer ${secrets.main}`],
    ])
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
  ['Authorization', 'Bearer sk-ant-oat01-client-own'],
  ['x-api-key', 'sk-ant-api03-client-own'],
  ['x_api_key', 'sk-ant-api03-client-own'],
])('the container own %s is replaced by the account bearer', async (header, value) => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { [header]: value },
  })

  expect(response.status).toBe(200)
  expect(upstream.requests).toHaveLength(1)
  expect(slotLines(upstream.requests[0]?.rawHeaders ?? [])).toEqual([
    ['authorization', `Bearer ${secrets.main}`],
  ])
})

test('a container spawned before its account is added reaches the upstream as an OAuth request', async () => {
  const { upstream, tunnel, addKey, containerEnv } = await setupCredentials()
  const env = containerEnv()
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: groupSelector })
  addKey('main', secrets.second)

  const response = await sendTestRequest(tunnel, {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ''}`,
      'anthropic-version': '2023-06-01',
    },
    body: '{}',
  })

  expect(response.status).toBe(200)
  expect(response.headers['x-kurumi-account']).toBe('anthropic/main')
  expect(upstream.requests[0]?.headers).toMatchObject({
    authorization: `Bearer ${secrets.second}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
})

test('a container selector follows a later default and keeps the OAuth beta', async () => {
  const { upstream, tunnel, addKey, setDefault, containerEnv } = await setupCredentials()
  addKey('subscription', secrets.second)
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
  expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${secrets.main}`)
  expect(upstream.requests[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20')
})

test('credential injection refuses a non-443 port before choosing an account', async () => {
  const inject = credentialInject({
    credentialFor: () => {
      throw new Error('no account should be chosen')
    },
  })

  expect(
    await inject({
      principal: { agentGroupId: 'g1' },
      host: 'api.anthropic.com',
      port: 8443,
      method: 'GET',
      path: '/v1/models',
      headers: new Headers(),
      rawHeaders: [],
    }),
  ).toEqual({ refusal: { code: 'port_not_allowed', host: 'api.anthropic.com', port: 8443 } })
})

test('a TRACE to a credentialed host is refused with 405 and nothing goes upstream', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await sendTestRequest(tunnel, {
    method: 'TRACE',
    path: '/v1/models',
    headers: { authorization: `Bearer ${groupSelector}` },
  })

  expect(response.status).toBe(405)
  expect(response.headers.allow).toBe('GET, HEAD, POST, PUT, PATCH, DELETE')
  expect(JSON.parse(response.body)).toMatchObject({ error: 'method_not_allowed', method: 'TRACE' })
  expect(upstream.requests).toEqual([])
})

test('a TRACK to a credentialed host is refused with 405 and nothing goes upstream', async () => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await sendTestRequest(tunnel, {
    method: 'TRACK',
    path: '/v1/models',
    headers: { authorization: `Bearer ${groupSelector}` },
  })

  expect(response.status).toBe(405)
  expect(response.headers.allow).toBe('GET, HEAD, POST, PUT, PATCH, DELETE')
  expect(response.headers['content-type']).toBe('application/json')
  expect(response.headers['x-should-retry']).toBe('false')
  expect(response.headers['x-kurumi-gateway']).toBe('method_not_allowed')
  expect(JSON.parse(response.body)).toEqual({
    error: 'method_not_allowed',
    service: 'anthropic-api',
    method: 'TRACK',
    allowed: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    next: 'send the request as one of GET, HEAD, POST, PUT, PATCH, DELETE; kurumi adds no credential to TRACK',
  })
  expect(response.body).not.toContain(secrets.main)
  expect(upstream.requests).toEqual([])
})

test.each([
  'GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nBad Header: value\r\n\r\n',
  'TR@CK /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n',
])('malformed credentialed HTTP closes without a method refusal: %s', async (bytes) => {
  const { upstream, tunnel, addKey } = await setupCredentials()
  addKey('main', secrets.main)

  const response = await exchangeRaw(tunnel.socket, bytes)

  expect(response.status).toBeNaN()
  expect(response.body).toBe('')
  expect(upstream.requests).toEqual([])
})

test('a parser-rejected method without a credential refusal closes without going upstream', async () => {
  const { upstream, tunnel } = await setup()

  const response = await exchangeRaw(
    tunnel.socket,
    'TRACK /echo HTTP/1.1\r\nHost: fake.test\r\n\r\n',
  )

  expect(response.status).toBeNaN()
  expect(response.body).toBe('')
  expect(upstream.requests).toEqual([])
})

test('a group with no account is refused with a JSON 403 and nothing goes upstream', async () => {
  const { upstream, tunnel } = await setupCredentials()

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { authorization: `Bearer ${groupSelector}` },
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

test('an unconnected Google service names the connect tool before any upstream request', async () => {
  const { upstream, tunnel } = await setupCredentials({
    target: { host: 'gmail.googleapis.com', port: 443 },
  })
  const response = await sendTestRequest(tunnel, { path: '/gmail/v1/users/me/profile' })
  expect(response.status).toBe(403)
  expect(JSON.parse(response.body)).toEqual({
    error: 'account_not_connected',
    service: 'gmail',
    next: 'no account is granted gmail for this agent group; call mcp__kurumi__connect_account with services=["gmail"]',
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
  addKey('second', secrets.second)

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
  addKey('second', secrets.second)
  setDefault('anthropic/main')

  const response = await sendTestRequest(tunnel, {
    path: '/v1/models',
    headers: { authorization: 'Bearer sk-ant-kurumi-YW50aHJvcGljL3NlY29uZA' },
  })

  expect(response.headers['x-kurumi-account']).toBe('anthropic/second')
  expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${secrets.second}`)
})

test('the default serves a request that names no account', async () => {
  const { tunnel, addKey, setDefault } = await setupCredentials()
  addKey('main', secrets.main)
  addKey('second', secrets.second)
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
  const target = { host, port: address.port }
  const context = { principal: {}, target, signal: new AbortController().signal }
  const deps = {
    resolve,
    addressRefusal,
    hostAddresses,
    inject: ({ path, headers }) => ({ path, headers }),
  } satisfies ForwardDeps<object>
  const ca = await createCertificateAuthority()
  const leaf = await ca.leafFor(host)
  const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, async (req, res) => {
    await forward(context, req, res, deps)
  })
  server.on('upgrade', async (req, client, head) => {
    await forwardUpgrade(context, req, client, head, deps)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  stops.push(() => {
    server.closeAllConnections()
    server.close()
  })
  const endpoint = server.address()
  if (!endpoint || typeof endpoint === 'string') throw new Error('server has no TCP address')
  const socket = connect({
    host: '127.0.0.1',
    port: endpoint.port,
    servername: host,
    ca: ca.certPem,
  })
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  agent.createConnection = () => socket
  const close = () => {
    agent.destroy()
    socket.destroy()
  }
  stops.push(close)
  await once(socket, 'secureConnect')
  const tunnel = { target, socket, agent, close }
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
    { host: 'pinned.invalid', addressRefusal: () => () => null },
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
    headers: { authorization: `Bearer ${groupSelector}` },
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
    headers: { authorization: `Bearer ${written}` },
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

test.each(['TRACE', 'TRACK'])('a %s refused with 405 is logged as refused', async (method) => {
  const { tunnel, addKey, events } = await setupLogged()
  addKey('main', secrets.main)
  const response = await sendTestRequest(tunnel, {
    method,
    path: '/v1/models?key=kurumi:anthropic/main',
    headers: { authorization: `Bearer ${groupSelector}` },
  })
  expect(response.status).toBe(405)
  await until(() => events.length === 1)
  expect(events).toEqual([
    {
      decision: 'refused',
      refusal: 'method_not_allowed',
      service: 'anthropic-api',
      principal: { agentGroupId: 'g1' },
      at: expect.any(Number),
      host: 'api.anthropic.com',
      method,
      path: '/v1/models',
      status: 405,
      durationMs: expect.any(Number),
    },
  ])
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

test('an accepted passthrough CONNECT logs one principal-attributed row, not its inner requests', async () => {
  const events: EgressEvent<EgressPrincipal>[] = []
  const upstream = await startFakeUpstream({ host: '127.0.0.1' })
  stops.push(upstream.stop)
  const principal = { agentGroupId: 'g1', sessionId: 's1' }
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? principal : null),
    intercepts: () => false,
    addressRefusal: () => () => null,
    forward: {
      inject: () => {
        throw new Error('passthrough must not inspect requests')
      },
      log: (event) => events.push(event),
    },
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: upstream.caPem,
    target: { host: '127.0.0.1', port: upstream.port },
  })
  stops.push(tunnel.close)
  expect(events).toEqual([
    {
      decision: 'passed',
      principal,
      at: expect.any(Number),
      host: '127.0.0.1',
      method: 'CONNECT',
      path: `127.0.0.1:${upstream.port}`,
      status: 200,
      durationMs: expect.any(Number),
    },
  ])
  expect((await sendTestRequest(tunnel, { path: '/first?secret=not-logged' })).status).toBe(200)
  expect((await sendTestRequest(tunnel, { path: '/second' })).status).toBe(200)
  tunnel.close()
  await gateway.stop()
  expect(events).toHaveLength(1)
})

test.each(['dial', 'dns', 'authentication', 'authority'])(
  'a CONNECT rejected by %s never logs an accepted tunnel',
  async (failure) => {
    const events: EgressEvent<EgressPrincipal>[] = []
    const upstream = await startFakeUpstream({ host: '127.0.0.1' })
    await upstream.stop()
    const gateway = await startAgentPort({
      bind: { host: '127.0.0.1', port: 0 },
      authenticate: () =>
        failure === 'authentication' ? null : { agentGroupId: 'g1', sessionId: 's1' },
      intercepts: () => false,
      addressRefusal: () => () => null,
      resolve: async () => {
        if (failure === 'dns') throw new Error('DNS failed')
        return [{ address: '127.0.0.1', family: 4 }]
      },
      forward: {
        inject: ({ path, headers }) => ({ path, headers }),
        log: (event) => events.push(event),
      },
    })
    stops.push(gateway.stop)
    const target = failure === 'authority' ? 'invalid.test' : `dial.test:${upstream.port}`
    expect(await connectStatus(gateway.port, target)).toBe(
      failure === 'authentication' ? 407 : failure === 'authority' ? 400 : 502,
    )
    await gateway.stop()
    expect(events).toEqual([])
  },
)

test('CONNECT to an intercepted host on another port is logged as refused with no service', async () => {
  const events: EgressEvent<CredentialPrincipal>[] = []
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: () => ({ agentGroupId: 'g1' }),
    intercepts: isInterceptedHost,
    forward: {
      inject: ({ path, headers }) => ({ path, headers }),
      log: (event) => events.push(event),
    },
  })
  stops.push(gateway.stop)

  expect(await connectStatus(gateway.port, 'api.anthropic.com:8443')).toBe(403)
  await until(() => events.length === 1)
  expect(events[0]).toMatchObject({
    decision: 'refused',
    refusal: 'port_not_allowed',
    service: null,
    method: 'CONNECT',
    path: 'api.anthropic.com:8443',
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

test('an injected request names the service of the injection the ledger chose', async () => {
  const handle = accountHandle('anthropic', 'main')
  const inject = credentialInject({
    credentialFor: async (_principal, egress) => ({
      kind: 'inject',
      injection: {
        service: 'anthropic-api',
        handle,
        accountId: 'a1',
        unauthorized: () => {},
        apply: () => ({ path: egress.path, headers: egress.headers }),
        toJSON: () => {
          throw new Error('an injection is never serialized')
        },
      },
    }),
  })
  expect(
    await inject({
      principal: { agentGroupId: 'g1' },
      host: 'api.anthropic.com',
      port: 443,
      method: 'POST',
      path: '/v1/messages',
      headers: new Headers(),
      rawHeaders: [],
    }),
  ).toMatchObject({ account: { handle, service: 'anthropic-api' } })
})

type Requested = Parameters<GatewayApprovals['request']>[1] & { approvalId: string }

type RuleInput = Parameters<EgressApproval['rules']['add']>[0]

async function setupHeld({
  holdMs,
  bodyDeadlineMs,
  now,
  deps,
  rule: ruleInput = {
    account: 'anthropic/main',
    method: 'POST',
    path: '/v1/messages',
    priority: 0,
    effect: 'approve',
  },
}: {
  holdMs?: number
  bodyDeadlineMs?: number
  now?: () => number
  deps?: Pick<ForwardDeps<EgressPrincipal>, 'upstream' | 'resolve' | 'gate'>
  rule?: RuleInput
} = {}) {
  const db = inMemoryDb()
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  insertAgentGroup(db, 'g1')
  const ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
  db.transaction((tx) =>
    ledger.addKey(tx, {
      vendor: 'anthropic',
      label: 'main',
      value: secrets.main,
      autoGrant: true,
    }),
  )
  const requested: Requested[] = []
  const notices: SessionNotice[] = []
  const gate = createEgressApproval({
    db,
    accounts: ledger,
    approvals: {
      request: (_tx, input) => {
        const approvalId = `apr-${requested.length + 1}`
        requested.push({ ...input, approvalId })
        return { approvalId }
      },
    },
    queueNotice: (_tx, notice) => {
      if (notices.some(({ key }) => key === notice.key)) return 'duplicate'
      notices.push(notice)
      return 'queued'
    },
    deliverNotice: () => {},
    log: () => {},
    holdMs,
    now,
  })
  const rule = gate.rules.add(ruleInput)
  const events: EgressEvent<EgressPrincipal>[] = []
  const upstream = await startFakeUpstream({ host: 'api.anthropic.com' })
  stops.push(upstream.stop)
  const principals = new Map<string, EgressPrincipal>()
  const port = await startAgentPort<EgressPrincipal>({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => principals.get(token) ?? null,
    intercepts: isInterceptedHost,
    forward: {
      upstream: upstream.destination,
      inject: credentialInject(ledger),
      log: (event) => events.push(event),
      gate,
      bodyDeadlineMs,
      ...deps,
    },
  })
  stops.push(port.stop)
  const openTunnel = async (
    principal: EgressPrincipal = { agentGroupId: 'g1', sessionId: 's1' },
  ) => {
    const token = `token-${principal.agentGroupId}-${principal.sessionId}`
    principals.set(token, principal)
    const tunnel = await openTestTunnel({
      proxyPort: port.port,
      token,
      caPem: port.caPem,
      target: { host: 'api.anthropic.com', port: 443 },
    })
    stops.push(tunnel.close)
    return tunnel
  }
  const addAccount = (label: string, value: string) =>
    db.transaction((tx) =>
      ledger.addKey(tx, { vendor: 'anthropic', label, value, autoGrant: true }),
    )
  const addAgentGroup = (id: string) => {
    insertAgentGroup(db, id)
    db.transaction((tx) => ledger.grantAutoGrants(tx, id))
  }
  const allowance = (approvalId: string) =>
    db.select().from(egressAllowance).where(eq(egressAllowance.approvalId, approvalId)).get()
  const approvalId = (index: number) => {
    const found = requested[index]?.approvalId
    if (found === undefined) throw new Error(`no approval #${index + 1} was requested`)
    return found
  }
  return {
    gate,
    rule,
    upstream,
    port,
    tunnel: await openTunnel(),
    openTunnel,
    addAccount,
    addAgentGroup,
    requested,
    approvalId,
    notices,
    events,
    allowance,
  }
}

const prompt = (text = 'hello') =>
  JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: text }] })

const sendMessage = (
  tunnel: Awaited<ReturnType<typeof openTestTunnel>>,
  body = prompt(),
  headers: Record<string, string> = {},
) => sendTestRequest(tunnel, { method: 'POST', path: '/v1/messages', headers, body })

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

const decisions = (events: readonly EgressEvent<EgressPrincipal>[]) =>
  events.map((event) => [
    event.decision,
    event.decision === 'refused' ? event.refusal : null,
    event.status,
  ])

const streamUpgrade = () =>
  `GET /v1/stream HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`

const addStreamRule = (gate: EgressApproval) =>
  gate.rules.add({
    account: 'anthropic/main',
    path: '/v1/stream',
    priority: 0,
    effect: 'approve',
  })

const scopedRule: RuleInput = {
  service: 'anthropic-api',
  method: 'POST',
  path: '/v1/messages/*',
  priority: 0,
  effect: 'approve',
}
const selectorOf = (handle: string) => `sk-ant-kurumi-${Buffer.from(handle).toString('base64url')}`
const sendScoped = (
  tunnel: Awaited<ReturnType<typeof openTestTunnel>>,
  { path = '/v1/messages', handle = 'anthropic/main' } = {},
) =>
  sendTestRequest(tunnel, {
    method: 'POST',
    path,
    headers: { authorization: `Bearer ${selectorOf(handle)}` },
    body: prompt('scoped'),
  })
const granted = 1_800_000_000_000

const stalledMessage =
  'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 1000\r\n\r\n{'

const withinTwoSeconds = <T>(answer: Promise<T>) =>
  Promise.race([
    answer,
    Bun.sleep(2_000).then((): never => {
      throw new Error('the gateway kept the exchange open for 2 s')
    }),
  ])

describe('held requests', () => {
  test('hold then approve: the upstream receives the exact body once and the client its 200', async () => {
    const { gate, upstream, tunnel, requested, approvalId, events, notices } = await setupHeld()
    const body = prompt('approve me')
    const response = sendMessage(tunnel, body, { 'transfer-encoding': 'chunked' })
    await until(() => requested.length === 1)
    await Bun.sleep(20)
    expect(upstream.requests).toEqual([])

    await gate.decided({ id: approvalId(0) }, 'approve')

    expect((await response).status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.body).toEqual({
      kind: 'complete',
      bytes: Buffer.byteLength(body),
      sha256: sha256Hex(body),
    })
    expect(upstream.requests[0]?.headers).toMatchObject({
      'content-length': String(Buffer.byteLength(body)),
      authorization: `Bearer ${secrets.main}`,
    })
    expect(upstream.requests[0]?.headers['transfer-encoding']).toBeUndefined()
    await until(() => events.length === 2)
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['injected', null, 200],
    ])
    expect(events[0]?.at).toBe(events[1]?.at ?? 0)
    expect(notices).toEqual([])
  })

  test('hold then deny: the client reads 403 approval_denied and nothing goes upstream', async () => {
    const { gate, upstream, tunnel, requested, approvalId, events, notices } = await setupHeld()
    const response = sendMessage(tunnel)
    await until(() => requested.length === 1)
    const id = approvalId(0)

    await gate.decided({ id }, 'deny')

    const answer = await response
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({
      error: 'approval_denied',
      service: 'anthropic-api',
      approvalId: id,
      next: `a person denied ${id}; do not send this request again unless the user asks for it`,
    })
    expect(upstream.requests).toEqual([])
    await until(() => events.length === 2)
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['refused', 'approval_denied', 403],
    ])
    expect(notices).toEqual([])
  })

  test('the card names the request, the rule, and the body, and never the credential', async () => {
    const { gate, rule, tunnel, requested, approvalId, events } = await setupHeld()
    const body = prompt('card')
    const response = sendTestRequest(tunnel, {
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: { authorization: `Bearer ${groupSelector}` },
      body,
    })
    await until(() => requested.length === 1)

    expect(requested).toEqual([
      {
        kind: 'gateway.request',
        agentGroupId: 'g1',
        sessionId: 's1',
        title: 'POST https://api.anthropic.com/v1/messages?beta=true as anthropic/main',
        body: [
          'agent group g1, session s1',
          `rule ${rule.id}, service anthropic-api`,
          `body ${Buffer.byteLength(body)} bytes, sha256 ${sha256Hex(body)}`,
          body,
        ],
        payload: {},
        approvalId: approvalId(0),
      },
    ])
    await gate.decided({ id: approvalId(0) }, 'deny')
    await response
    await until(() => events.length === 2)
    expect(JSON.stringify([requested, events])).not.toContain(secrets.main)
  })

  test('the card names the method override and the body framing a person approves', async () => {
    const { gate, rule, tunnel, requested, approvalId } = await setupHeld()
    const body = prompt('framed card')
    const response = sendTestRequest(tunnel, {
      method: 'PUT',
      path: '/v1/messages',
      headers: {
        'X-HTTP-Method-Override': 'post',
        'content-type': 'Application/JSON',
        'content-encoding': 'identity',
      },
      body,
    })
    await until(() => requested.length === 1)

    expect(requested[0]).toMatchObject({
      title: 'PUT https://api.anthropic.com/v1/messages as anthropic/main, method override POST',
      body: [
        'agent group g1, session s1',
        `rule ${rule.id}, service anthropic-api`,
        'content-type application/json, content-encoding identity',
        `body ${Buffer.byteLength(body)} bytes, sha256 ${sha256Hex(body)}`,
        body,
      ],
    })
    await gate.decided({ id: approvalId(0) }, 'deny')
    await response
  })

  test.each([
    ['a method override header', {}, { 'X-HTTP-Method-Override': 'DELETE' }],
    [
      'a changed content-type',
      { 'content-type': 'application/json' },
      { 'content-type': 'text/plain' },
    ],
    ['an empty content-type', {}, { 'content-type': '' }],
    ['a content-encoding', {}, { 'content-encoding': 'gzip' }],
  ] satisfies [string, Record<string, string>, Record<string, string>][])(
    'an approved request resent with %s holds again and sends nothing upstream',
    async (_name, approvedHeaders, changedHeaders) => {
      const { gate, upstream, tunnel, approvalId, allowance } = await setupHeld({ holdMs: 50 })
      const body = prompt('framed')
      await sendMessage(tunnel, body, approvedHeaders)
      await gate.decided({ id: approvalId(0) }, 'approve')

      const resent = await sendMessage(tunnel, body, { ...approvedHeaders, ...changedHeaders })

      expect(resent.status).toBe(403)
      expect(JSON.parse(resent.body)).toMatchObject({
        error: 'approval_pending',
        approvalId: approvalId(1),
      })
      expect(upstream.requests).toEqual([])
      expect(allowance(approvalId(0))).toMatchObject({ state: 'granted' })
    },
  )

  test('timeout then allowance: a later approval notifies the session once and leaves a granted row', async () => {
    const at = 1_800_000_000_000
    const { gate, upstream, tunnel, approvalId, notices, allowance, events } = await setupHeld({
      holdMs: 50,
      now: () => at,
    })

    const answer = await sendMessage(tunnel)

    const id = approvalId(0)
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toMatchObject({ error: 'approval_pending', approvalId: id })
    await until(() => events.length === 2)
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['refused', 'approval_pending', 403],
    ])
    expect(allowance(id)).toMatchObject({ state: 'pending' })

    await gate.decided({ id }, 'approve')

    expect(notices).toEqual([
      {
        key: id,
        sessionId: 's1',
        text: `kurumi: approval ${id} was approved: POST https://api.anthropic.com/v1/messages as anthropic/main. The first attempt ended before the decision. Send exactly the same request with the same body before ${new Date(at + ALLOWANCE_MS).toISOString()}; it passes once. A changed body needs a new approval.`,
      },
    ])
    expect(allowance(id)).toMatchObject({
      state: 'granted',
      expiresAt: new Date(at + ALLOWANCE_MS),
    })
    expect(upstream.requests).toEqual([])
  })

  test('a deny after the hold ended tells the session not to send the request again', async () => {
    const { gate, tunnel, approvalId, notices } = await setupHeld({ holdMs: 50 })
    await sendMessage(tunnel)
    const id = approvalId(0)

    await gate.decided({ id }, 'deny')

    expect(notices).toEqual([
      {
        key: id,
        sessionId: 's1',
        text: `kurumi: approval ${id} was denied: POST https://api.anthropic.com/v1/messages as anthropic/main. Do not send this request again unless the user asks for it.`,
      },
    ])
  })

  test('identical resend passes once without a new hold, and a second resend holds again', async () => {
    const { gate, upstream, tunnel, requested, approvalId, allowance, events } = await setupHeld({
      holdMs: 50,
    })
    const body = prompt('resend me')
    await sendMessage(tunnel, body)
    await gate.decided({ id: approvalId(0) }, 'approve')

    const resend = await sendMessage(tunnel, body)

    expect(resend.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.body).toMatchObject({ sha256: sha256Hex(body) })
    expect(requested).toHaveLength(1)
    expect(allowance(approvalId(0))).toMatchObject({ state: 'used' })

    const again = await sendMessage(tunnel, body)

    expect(again.status).toBe(403)
    expect(JSON.parse(again.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: approvalId(1),
    })
    expect(upstream.requests).toHaveLength(1)
    await until(() => events.length === 5)
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['refused', 'approval_pending', 403],
      ['injected', null, 200],
      ['held', null, null],
      ['refused', 'approval_pending', 403],
    ])
  })

  test('an edited body holds again under a new approval', async () => {
    const { gate, upstream, tunnel, requested, approvalId, allowance } = await setupHeld({
      holdMs: 50,
    })
    await sendMessage(tunnel, prompt('the body a person read'))
    await gate.decided({ id: approvalId(0) }, 'approve')

    const edited = await sendMessage(tunnel, prompt('a body nobody read'))

    expect(edited.status).toBe(403)
    expect(requested).toHaveLength(2)
    expect(JSON.parse(edited.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: approvalId(1),
    })
    expect(approvalId(1)).not.toBe(approvalId(0))
    expect(upstream.requests).toEqual([])
    expect(allowance(approvalId(0))).toMatchObject({ state: 'granted' })
  })

  test.each([
    [
      'the clock past the allowance',
      ({ tunnel, setClock }) => {
        setClock(granted + ALLOWANCE_MS + 1)
        return sendScoped(tunnel)
      },
    ],
    [
      'another session',
      async ({ openTunnel }) =>
        sendScoped(await openTunnel({ agentGroupId: 'g1', sessionId: 's2' })),
    ],
    [
      'another query string',
      ({ tunnel }) => sendScoped(tunnel, { path: '/v1/messages?beta=true' }),
    ],
    ['another account handle', ({ tunnel }) => sendScoped(tunnel, { handle: 'anthropic/second' })],
    [
      'another rule',
      ({ tunnel, gate, rule }) => {
        gate.rules.remove(rule.id)
        gate.rules.add(scopedRule)
        return sendScoped(tunnel)
      },
    ],
    ['another path', ({ tunnel }) => sendScoped(tunnel, { path: '/v1/messages/count_tokens' })],
  ] satisfies [
    string,
    (
      held: Awaited<ReturnType<typeof setupHeld>> & { setClock: (at: number) => void },
    ) => ReturnType<typeof sendTestRequest>,
  ][])('an allowance never passes a resend with %s', async (_name, resend) => {
    let clock = granted
    const held = await setupHeld({ holdMs: 50, now: () => clock, rule: scopedRule })
    held.addAccount('second', secrets.second)
    expect((await sendScoped(held.tunnel)).status).toBe(403)
    await held.gate.decided({ id: held.approvalId(0) }, 'approve')

    const resent = await resend({
      ...held,
      setClock: (at) => {
        clock = at
      },
    })

    expect(resent.status).toBe(403)
    expect(JSON.parse(resent.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: held.approvalId(1),
    })
    expect(held.upstream.requests).toEqual([])
    expect(held.allowance(held.approvalId(0))).toMatchObject({ state: 'granted' })
  })

  test('a replayed decision notifies once and never passes a request twice', async () => {
    const { gate, upstream, tunnel, requested, approvalId, notices } = await setupHeld({
      holdMs: 50,
    })
    await sendMessage(tunnel)
    const id = approvalId(0)
    for (let replay = 0; replay < 3; replay++) await gate.decided({ id }, 'approve')
    expect(notices.map(({ key }) => key)).toEqual([id])

    expect((await sendMessage(tunnel)).status).toBe(200)
    await gate.decided({ id }, 'approve')
    const again = await sendMessage(tunnel)

    expect(again.status).toBe(403)
    expect(upstream.requests).toHaveLength(1)
    expect(requested).toHaveLength(2)
    expect(notices.map(({ key }) => key)).toEqual([id])
  })

  test('a decision for an approval the gateway never held is an error', async () => {
    const { gate } = await setupHeld()
    const failed = await gate.decided({ id: 'apr-unknown' }, 'approve').then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toEqual(new Error('gateway approval apr-unknown has no egress allowance row'))
  })

  test('an identical request while the first waits is pending on the same approval', async () => {
    const { gate, tunnel, openTunnel, requested, approvalId } = await setupHeld()
    const first = sendMessage(tunnel)
    await until(() => requested.length === 1)

    const second = await sendMessage(await openTunnel())

    expect(second.status).toBe(403)
    expect(JSON.parse(second.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: approvalId(0),
    })
    expect(requested).toHaveLength(1)
    await gate.decided({ id: approvalId(0) }, 'approve')
    expect((await first).status).toBe(200)
  })

  test('an identical request after the first one hung up waits on the same approval', async () => {
    const { gate, tunnel, openTunnel, requested, approvalId, events } = await setupHeld()
    const first = sendMessage(tunnel).catch(() => 'hung up')
    await until(() => requested.length === 1)
    tunnel.close()
    expect(await first).toBe('hung up')
    await until(() => events.length === 2)
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['refused', 'approval_pending', null],
    ])

    const retried = sendMessage(await openTunnel())
    await until(() => events.length === 3)
    await gate.decided({ id: approvalId(0) }, 'approve')

    expect((await retried).status).toBe(200)
    expect(requested).toHaveLength(1)
  })

  test('a request with a method override header is held by a rule on the overriding method', async () => {
    const { gate, upstream, tunnel, requested, approvalId } = await setupHeld()
    const response = sendTestRequest(tunnel, {
      method: 'PUT',
      path: '/v1/messages',
      headers: { 'X-HTTP-Method-Override': 'POST' },
      body: prompt(),
    })
    await until(() => requested.length === 1)
    expect(upstream.requests).toEqual([])
    await gate.decided({ id: approvalId(0) }, 'deny')
    expect((await response).status).toBe(403)
  })

  test.each([
    ['a declared length', {}],
    ['a chunked body', { 'transfer-encoding': 'chunked' }],
  ])(
    'a held request with %s above 10 MiB reads 413 body_too_large and asks for no approval',
    async (_name, headers) => {
      const body = 'a'.repeat(MAX_HELD_BODY_BYTES + 1)
      for (let upload = 0; upload < 3; upload++) {
        const { upstream, tunnel, requested } = await setupHeld()

        const answer = await sendMessage(tunnel, body, headers)

        expect(answer.status).toBe(413)
        expect(JSON.parse(answer.body)).toEqual({
          error: 'body_too_large',
          service: 'anthropic-api',
          limit: MAX_HELD_BODY_BYTES,
          next: `a rule holds this request for a person to read, and kurumi holds at most ${MAX_HELD_BODY_BYTES} bytes; send a smaller body`,
        })
        expect(requested).toEqual([])
        expect(upstream.requests).toEqual([])
      }
    },
  )

  test('a held body of exactly 10 MiB waits for a person', async () => {
    const { gate, upstream, tunnel, requested, approvalId } = await setupHeld()
    const body = 'a'.repeat(MAX_HELD_BODY_BYTES)
    const response = sendMessage(tunnel, body)
    await until(() => requested.length === 1)

    await gate.decided({ id: approvalId(0) }, 'approve')

    expect((await response).status).toBe(200)
    expect(upstream.requests[0]?.body).toMatchObject({ bytes: MAX_HELD_BODY_BYTES })
  })

  test('a request no rule holds returns on another tunnel while a hold waits', async () => {
    const { gate, upstream, tunnel, openTunnel, requested, approvalId } = await setupHeld()
    let settled = false
    const held = sendMessage(tunnel).finally(() => {
      settled = true
    })
    await until(() => requested.length === 1)

    const models = await sendTestRequest(await openTunnel(), { path: '/v1/models' })

    expect(models.status).toBe(200)
    expect(settled).toBe(false)
    expect(upstream.requests.map(({ path }) => path)).toEqual(['/v1/models'])
    await gate.decided({ id: approvalId(0) }, 'deny')
    await held
  })

  test('requests past the undecided cap of an agent group read 429 approval_limit', async () => {
    const { gate, tunnel, requested, approvalId } = await setupHeld({ holdMs: 1 })
    for (let index = 0; index < MAX_UNDECIDED_PER_GROUP; index++) {
      expect((await sendMessage(tunnel, prompt(`undecided ${index}`))).status).toBe(403)
    }

    const over = await sendMessage(tunnel, prompt('one too many'))

    expect(over.status).toBe(429)
    expect(JSON.parse(over.body)).toEqual({
      error: 'approval_limit',
      service: 'anthropic-api',
      waiting: 'undecided',
      limit: MAX_UNDECIDED_PER_GROUP,
      next: `${MAX_UNDECIDED_PER_GROUP} requests of this agent group already wait for a person; ask the user to decide them with kurumi approval list`,
    })
    expect(requested).toHaveLength(MAX_UNDECIDED_PER_GROUP)

    await gate.decided({ id: approvalId(0) }, 'deny')

    expect((await sendMessage(tunnel, prompt('room again'))).status).toBe(403)
    expect(requested).toHaveLength(MAX_UNDECIDED_PER_GROUP + 1)
  })

  test('requests past the in-flight cap of the host read 429 approval_limit at once', async () => {
    const { gate, openTunnel, addAgentGroup, requested } = await setupHeld()
    const fullGroups = MAX_IN_FLIGHT / MAX_IN_FLIGHT_PER_GROUP
    for (let group = 2; group <= fullGroups + 1; group++) addAgentGroup(`g${group}`)
    const tunnels = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT }, (_, index) =>
        openTunnel({ agentGroupId: `g${1 + (index % fullGroups)}`, sessionId: `s${index}` }),
      ),
    )
    const waiting = tunnels.map((each, index) => sendMessage(each, prompt(`in flight ${index}`)))
    await until(() => requested.length === MAX_IN_FLIGHT)

    const over = await sendMessage(
      await openTunnel({ agentGroupId: `g${fullGroups + 1}`, sessionId: 's-over' }),
      prompt('one too many'),
    )

    expect(over.status).toBe(429)
    expect(JSON.parse(over.body)).toEqual({
      error: 'approval_limit',
      service: 'anthropic-api',
      waiting: 'in_flight',
      scope: 'host',
      limit: MAX_IN_FLIGHT,
      next: `${MAX_IN_FLIGHT} held requests already wait on this host; send this one again when one of them ends`,
    })
    expect(requested).toHaveLength(MAX_IN_FLIGHT)
    for (const { approvalId } of requested) await gate.decided({ id: approvalId }, 'deny')
    expect((await Promise.all(waiting)).map(({ status }) => status)).toEqual(
      Array.from({ length: MAX_IN_FLIGHT }, () => 403),
    )
  })

  test('an agent group at its in-flight cap leaves room for another group and reads 429 at once', async () => {
    const { gate, openTunnel, addAgentGroup, requested } = await setupHeld()
    addAgentGroup('g2')
    const tunnels = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_PER_GROUP }, () => openTunnel()),
    )
    const waiting = tunnels.map((each, index) => sendMessage(each, prompt(`g1 in flight ${index}`)))
    await until(() => requested.length === MAX_IN_FLIGHT_PER_GROUP)

    waiting.push(
      sendMessage(await openTunnel({ agentGroupId: 'g2', sessionId: 's2' }), prompt('g2 waits')),
    )
    await until(() => requested.length === MAX_IN_FLIGHT_PER_GROUP + 1)
    expect(requested.at(-1)).toMatchObject({ agentGroupId: 'g2', sessionId: 's2' })

    const over = await Promise.race([
      sendMessage(await openTunnel(), prompt('one too many')).then(({ status, body }) => ({
        status,
        body: JSON.parse(body),
      })),
      Bun.sleep(1_000).then(() => ({ status: 'still held after 1 s', body: null })),
    ])

    expect(over).toEqual({
      status: 429,
      body: {
        error: 'approval_limit',
        service: 'anthropic-api',
        waiting: 'in_flight',
        scope: 'agent_group',
        limit: MAX_IN_FLIGHT_PER_GROUP,
        next: `${MAX_IN_FLIGHT_PER_GROUP} held requests of this agent group already wait; send this one again when one of them ends`,
      },
    })
    expect(requested).toHaveLength(MAX_IN_FLIGHT_PER_GROUP + 1)
    for (const { approvalId } of requested) await gate.decided({ id: approvalId }, 'deny')
    expect((await Promise.all(waiting)).map(({ status }) => status)).toEqual(
      Array.from({ length: MAX_IN_FLIGHT_PER_GROUP + 1 }, () => 403),
    )
  })

  test('a port stop during a hold returns promptly and records the exchange as pending with no status', async () => {
    const { port, tunnel, requested, approvalId, events, allowance } = await setupHeld()
    const response = sendMessage(tunnel).then(
      () => 'answered',
      () => 'connection closed',
    )
    await until(() => requested.length === 1)
    const started = performance.now()

    await port.stop()

    expect(performance.now() - started).toBeLessThan(1_000)
    expect(await response).toBe('connection closed')
    expect(decisions(events)).toEqual([
      ['held', null, null],
      ['refused', 'approval_pending', null],
    ])
    expect(allowance(approvalId(0))).toMatchObject({ state: 'pending' })
  })

  test('held requests on one keep-alive tunnel leave no listeners behind', async () => {
    const { gate, tunnel, requested, approvalId } = await setupHeld()
    const warnings: string[] = []
    const warned = (warning: Error) => warnings.push(warning.message)
    process.on('warning', warned)
    stops.push(() => {
      process.off('warning', warned)
    })

    for (let index = 0; index < 12; index++) {
      const response = sendMessage(tunnel, prompt(`keep-alive ${index}`))
      await until(() => requested.length === index + 1)
      await gate.decided({ id: approvalId(index) }, 'approve')
      expect((await response).status).toBe(200)
    }
    await Bun.sleep(20)

    expect(warnings).toEqual([])
  })

  test.each([
    [
      'resolves to a non-public address',
      async () => [{ address: '127.0.0.1', family: 4 }],
      403,
      { error: 'upstream_not_public', host: 'api.anthropic.com', reason: 'loopback' },
      ['refused', 'upstream_not_public', 403],
    ],
    [
      'fails to resolve',
      () => Promise.reject(new Error('ENOTFOUND')),
      502,
      { error: 'upstream_unreachable', host: 'api.anthropic.com' },
      ['injected', null, 502],
    ],
  ] satisfies [
    string,
    (host: string) => Promise<LookupAddress[]>,
    number,
    object,
    ReturnType<typeof decisions>[number],
  ][])(
    'an approve-ruled request to a host that %s is answered at once and asks no one',
    async (_name, resolve, status, body, decision) => {
      const { upstream, tunnel, requested, events } = await setupHeld({
        holdMs: 50,
        deps: { upstream: undefined, resolve },
      })

      const answer = await sendMessage(tunnel)

      expect(answer.status).toBe(status)
      expect(JSON.parse(answer.body)).toMatchObject(body)
      expect(requested).toEqual([])
      expect(upstream.requests).toEqual([])
      await until(() => events.length === 1)
      expect(decisions(events)).toEqual([decision])
    },
  )

  test('a gate that throws at once leaves no listener on the tunnel signal or the response', async () => {
    const tunnel = new AbortController()
    const observed = Promise.withResolvers<{
      failed: unknown
      abortListeners: number
      closeListenersAdded: number
    }>()
    const server = createHttpServer(async (req, res) => {
      const closeListeners = res.listenerCount('close')
      const failed = await forward(
        { principal: {}, target: { host: 'api.anthropic.com', port: 443 }, signal: tunnel.signal },
        req,
        res,
        {
          upstream: { host: 'api.anthropic.com', address: '127.0.0.1', caPem: '' },
          inject: ({ path, headers }) => ({
            path,
            headers,
            account: { handle: accountHandle('anthropic', 'main'), service: 'anthropic-api' },
          }),
          gate: {
            screen: () => {
              throw new Error('egress rule rul-1 names no readable target')
            },
          },
        },
      ).then(
        () => null,
        (error: unknown) => error,
      )
      observed.resolve({
        failed,
        abortListeners: getEventListeners(tunnel.signal, 'abort').length,
        closeListenersAdded: res.listenerCount('close') - closeListeners,
      })
      res.writeHead(500).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    stops.push(() => {
      server.close()
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server has no TCP address')

    httpRequest({
      port: address.port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/v1/messages',
      headers: { host: 'api.anthropic.com' },
    })
      .on('error', () => {})
      .end(prompt())

    expect(await observed.promise).toEqual({
      failed: new Error('egress rule rul-1 names no readable target'),
      abortListeners: 0,
      closeListenersAdded: 0,
    })
  })

  test('a WebSocket upgrade an approve rule covers waits and is refused when denied', async () => {
    const { gate, tunnel, requested, approvalId } = await setupHeld()
    const rule = addStreamRule(gate)
    const exchanged = exchangeRaw(tunnel.socket, streamUpgrade())
    await until(() => requested.length === 1)

    expect(requested[0]).toMatchObject({
      title: 'GET https://api.anthropic.com/v1/stream as anthropic/main',
      body: [
        'agent group g1, session s1',
        `rule ${rule.id}, service anthropic-api`,
        'WebSocket upgrade: an approval covers the whole connection and every message on it',
      ],
    })
    await gate.decided({ id: approvalId(0) }, 'deny')

    const response = await exchanged
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'approval_denied',
      approvalId: approvalId(0),
    })
  })

  test('an approved plain GET does not open a WebSocket on the same path', async () => {
    const { gate, upstream, tunnel, openTunnel, approvalId, allowance } = await setupHeld({
      holdMs: 50,
    })
    addStreamRule(gate)
    expect((await sendTestRequest(tunnel, { path: '/v1/stream' })).status).toBe(403)
    await gate.decided({ id: approvalId(0) }, 'approve')

    const upgraded = await exchangeRaw((await openTunnel()).socket, streamUpgrade())

    expect(upgraded.status).toBe(403)
    expect(JSON.parse(upgraded.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: approvalId(1),
    })
    expect(upstream.requests).toEqual([])
    expect(allowance(approvalId(0))).toMatchObject({ state: 'granted' })
  })

  test('a raw fragment mark in the target is refused before an account, a rule, or the upstream sees it', async () => {
    const { upstream, tunnel, requested, events } = await setupHeld()
    const body = prompt('fragment')

    const answer = await withinTwoSeconds(
      exchangeRaw(
        tunnel.socket,
        `POST /v1/models#/../messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      ),
    )

    expect(answer.status).toBe(400)
    expect(requested).toEqual([])
    expect(upstream.requests).toEqual([])
    expect(events).toEqual([])
  })

  test('a GET approve rule holds a HEAD request to the same path', async () => {
    const { gate, upstream, tunnel, requested, approvalId } = await setupHeld({
      rule: {
        account: 'anthropic/main',
        method: 'GET',
        path: '/v1/models',
        priority: 0,
        effect: 'approve',
      },
    })
    const response = sendTestRequest(tunnel, { method: 'HEAD', path: '/v1/models' })
    await until(() => requested.length === 1)

    expect(requested[0]?.title).toBe('HEAD https://api.anthropic.com/v1/models as anthropic/main')
    await gate.decided({ id: approvalId(0) }, 'deny')
    expect((await response).status).toBe(403)
    expect(upstream.requests).toEqual([])
  })
})

describe('a request body that stops short', () => {
  test('the default body deadline answers a held body with 408 after 30 s', async () => {
    const { gate, upstream, tunnel, requested, events } = await setupHeld()
    const screen = jest.spyOn(gate, 'screen')
    jest.useFakeTimers()
    let answered = false
    const answer = exchangeRaw(tunnel.socket, stalledMessage).then((response) => {
      answered = true
      return response
    })
    try {
      while (screen.mock.calls.length === 0) await new Promise(setImmediate)
      jest.advanceTimersByTime(29_999)
      for (let turn = 0; turn < 10; turn++) await new Promise(setImmediate)
      expect(answered).toBe(false)
      jest.advanceTimersByTime(1)
      await new Promise(setImmediate)
      jest.advanceTimersByTime(0)
      expect(await answer).toMatchObject({ status: 408, headers: { connection: 'close' } })
      expect(JSON.parse((await answer).body)).toMatchObject({
        error: 'body_timeout',
        limitMs: 30_000,
      })
      expect(requested).toEqual([])
      expect(upstream.requests).toEqual([])
      expect(decisions(events)).toEqual([['refused', 'body_timeout', 408]])
    } finally {
      screen.mockRestore()
      jest.useRealTimers()
    }
  })

  test('the default body deadline answers an unreachable upstream with 502 after 30 s', async () => {
    const resolving = Promise.withResolvers<void>()
    const { tunnel, requested, upstream } = await setupHeld({
      deps: {
        upstream: undefined,
        resolve: async () => {
          resolving.resolve()
          throw new Error('ENOTFOUND')
        },
      },
    })
    jest.useFakeTimers()
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0)
    let answered = false
    const answer = exchangeRaw(tunnel.socket, stalledMessage).then((response) => {
      answered = true
      return response
    })
    try {
      await resolving.promise
      await new Promise(setImmediate)
      jest.advanceTimersByTime(29_999)
      for (let turn = 0; turn < 10; turn++) await new Promise(setImmediate)
      expect(answered).toBe(false)
      jest.advanceTimersByTime(1)
      const response = await answer
      expect(response).toMatchObject({ status: 502, headers: { connection: 'close' } })
      expect(response.body).toContain(
        JSON.stringify({ error: 'upstream_unreachable', host: 'api.anthropic.com' }),
      )
      expect(requested).toEqual([])
      expect(upstream.requests).toEqual([])
    } finally {
      clock.mockRestore()
      jest.useRealTimers()
    }
  })

  test('the default body deadline reaches an upgrade gate as a 30 s refusal limit', async () => {
    const { tunnel } = await setupHeld({
      deps: {
        gate: {
          screen: async ({ bodyDeadlineMs }) => ({
            kind: 'refuse',
            refusal: { code: 'body_timeout', service: 'anthropic-api', limitMs: bodyDeadlineMs },
          }),
        },
      },
    })
    const answer = await exchangeRaw(tunnel.socket, streamUpgrade())
    expect(answer.status).toBe(408)
    expect(JSON.parse(answer.body)).toMatchObject({ error: 'body_timeout', limitMs: 30_000 })
  })

  test('is answered 408 body_timeout at the deadline when a rule holds it, asks no one, and logs a refused row', async () => {
    const { upstream, tunnel, requested, events } = await setupHeld({ bodyDeadlineMs: 100 })

    const answer = await withinTwoSeconds(exchangeRaw(tunnel.socket, stalledMessage))

    expect(answer).toMatchObject({ status: 408, headers: { connection: 'close' } })
    expect(JSON.parse(answer.body)).toEqual({
      error: 'body_timeout',
      service: 'anthropic-api',
      limitMs: 100,
      next: 'a rule holds this request for a person to read, and kurumi waits at most 0.1 s for its body; send the whole body at once',
    })
    expect(requested).toEqual([])
    expect(upstream.requests).toEqual([])
    await until(() => events.length === 1)
    expect(decisions(events)).toEqual([['refused', 'body_timeout', 408]])
  })

  test('gives back the in-flight slot of its hold, so a full agent group can hold again', async () => {
    const { gate, openTunnel, requested, approvalId } = await setupHeld({ bodyDeadlineMs: 100 })
    const stalled = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_PER_GROUP }, (_, index) =>
        openTunnel({ agentGroupId: 'g1', sessionId: `stalled ${index}` }),
      ),
    )

    const answers = await withinTwoSeconds(
      Promise.all(stalled.map(({ socket }) => exchangeRaw(socket, stalledMessage))),
    )

    expect(answers.map(({ status }) => status)).toEqual(
      Array.from({ length: MAX_IN_FLIGHT_PER_GROUP }, () => 408),
    )
    const next = sendMessage(await openTunnel({ agentGroupId: 'g1', sessionId: 'after' }))
    await until(() => requested.length === 1)
    await gate.decided({ id: approvalId(0) }, 'deny')
    expect((await next).status).toBe(403)
  })

  test('is cut off at the deadline even while bytes still trickle in', async () => {
    const { tunnel, requested } = await setupHeld({ bodyDeadlineMs: 150 })
    const trickle = setInterval(() => tunnel.socket.write('a'), 30)
    stops.push(() => clearInterval(trickle))

    const answer = await withinTwoSeconds(exchangeRaw(tunnel.socket, stalledMessage))

    expect(answer.status).toBe(408)
    expect(requested).toEqual([])
  })

  test.each([
    [
      'a body declared over 10 MiB',
      'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 20000000\r\n\r\n{',
      413,
      'body_too_large' as const,
    ],
    [
      'an account the agent group is not granted',
      'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer kurumi:anthropic/nobody-granted\r\nContent-Length: 1000\r\n\r\n{',
      403,
      'account_not_granted' as const,
    ],
  ])(
    'is answered with Connection: close at the deadline when %s is refused before the body is read',
    async (_name, stalled, status, refusal) => {
      const { tunnel, events } = await setupHeld({ bodyDeadlineMs: 100 })

      const answer = await withinTwoSeconds(exchangeRaw(tunnel.socket, stalled))

      expect(answer).toMatchObject({ status, headers: { connection: 'close' } })
      expect(JSON.parse(answer.body)).toMatchObject({ error: refusal })
      await until(() => events.length === 1)
      expect(decisions(events)).toEqual([['refused', refusal, status]])
    },
  )
})

async function restartableUpstream() {
  const ca = await createCertificateAuthority()
  let current = await startFakeUpstream({ host: 'api.anthropic.com', ca })
  const { destination, port } = current
  stops.push(() => current.stop())
  return {
    destination,
    stop: () => current.stop(),
    restart: async () => {
      current = await startFakeUpstream({ host: 'api.anthropic.com', ca, port })
    },
    requests: () => current.requests,
  }
}

async function upstreamThatResetsAfterTheRequest() {
  const ca = await createCertificateAuthority()
  const leaf = await ca.leafFor('api.anthropic.com')
  const received: string[] = []
  const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req) => {
    received.push(`${req.method} ${req.url}`)
    req.resume()
    req.once('end', () => req.socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  stops.push(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('upstream has no TCP address')
  return {
    destination: {
      host: 'api.anthropic.com',
      address: '127.0.0.1',
      port: address.port,
      caPem: ca.certPem,
    },
    received,
  }
}

describe('an approved request the upstream never received', () => {
  test('a live hold approved while the upstream is down answers 502, and the identical resend passes on that approval', async () => {
    const upstream = await restartableUpstream()
    const { gate, tunnel, openTunnel, requested, approvalId, allowance } = await setupHeld({
      deps: { upstream: upstream.destination },
    })
    const body = prompt('upstream down')
    const first = sendMessage(tunnel, body)
    await until(() => requested.length === 1)
    await upstream.stop()

    await gate.decided({ id: approvalId(0) }, 'approve')

    const failed = await first
    expect(failed.status).toBe(502)
    expect(JSON.parse(failed.body)).toEqual({
      error: 'upstream_unreachable',
      host: 'api.anthropic.com',
    })
    expect(allowance(approvalId(0))).toMatchObject({ state: 'granted', usedAt: null })
    await upstream.restart()
    expect((await sendMessage(await openTunnel(), body)).status).toBe(200)
    expect(requested).toHaveLength(1)
    expect(upstream.requests()).toHaveLength(1)
    expect(allowance(approvalId(0))).toMatchObject({ state: 'used' })
  })

  test('an allowance resend whose upstream is down answers 502 and keeps the allowance for the next resend', async () => {
    const upstream = await restartableUpstream()
    const { gate, tunnel, openTunnel, requested, approvalId, allowance } = await setupHeld({
      holdMs: 50,
      deps: { upstream: upstream.destination },
    })
    const body = prompt('resend while down')
    expect((await sendMessage(tunnel, body)).status).toBe(403)
    await gate.decided({ id: approvalId(0) }, 'approve')
    await upstream.stop()

    expect((await sendMessage(tunnel, body)).status).toBe(502)

    expect(allowance(approvalId(0))).toMatchObject({ state: 'granted', usedAt: null })
    await upstream.restart()
    expect((await sendMessage(await openTunnel(), body)).status).toBe(200)
    expect(requested).toHaveLength(1)
    expect(allowance(approvalId(0))).toMatchObject({ state: 'used' })
  })

  test('an approved WebSocket upgrade whose upstream is down keeps the allowance', async () => {
    const upstream = await restartableUpstream()
    const { gate, tunnel, openTunnel, requested, approvalId, allowance } = await setupHeld({
      deps: { upstream: upstream.destination },
    })
    addStreamRule(gate)
    const exchanged = exchangeRaw(tunnel.socket, streamUpgrade())
    await until(() => requested.length === 1)
    await upstream.stop()

    await gate.decided({ id: approvalId(0) }, 'approve')

    expect((await exchanged).status).toBe(502)
    expect(allowance(approvalId(0))).toMatchObject({ state: 'granted', usedAt: null })
    expect((await exchangeRaw((await openTunnel()).socket, streamUpgrade())).status).toBe(502)
    expect(requested).toHaveLength(1)
  })

  test('an upstream that fails after it received the request uses the allowance', async () => {
    const upstream = await upstreamThatResetsAfterTheRequest()
    const { gate, tunnel, openTunnel, requested, approvalId, allowance } = await setupHeld({
      holdMs: 50,
      deps: { upstream: upstream.destination },
    })
    const body = prompt('reset after the request')
    expect((await sendMessage(tunnel, body)).status).toBe(403)
    await gate.decided({ id: approvalId(0) }, 'approve')

    expect((await sendMessage(tunnel, body)).status).toBe(502)

    expect(upstream.received).toEqual(['POST /v1/messages'])
    expect(allowance(approvalId(0))).toMatchObject({ state: 'used' })
    const again = await sendMessage(await openTunnel(), body)
    expect(JSON.parse(again.body)).toMatchObject({
      error: 'approval_pending',
      approvalId: approvalId(1),
    })
    expect(requested).toHaveLength(2)
  })

  test('a second hand-back after the allowance passed another request gives nothing back', async () => {
    const { gate, tunnel, approvalId, allowance } = await setupHeld({ holdMs: 50 })
    const body = prompt('hand back once')
    expect((await sendMessage(tunnel, body)).status).toBe(403)
    await gate.decided({ id: approvalId(0) }, 'approve')
    const resend = async () => {
      const screened = await gate.screen({
        principal: { agentGroupId: 'g1', sessionId: 's1' },
        account: { handle: accountHandle('anthropic', 'main'), service: 'anthropic-api' },
        host: 'api.anthropic.com',
        method: 'POST',
        methodOverrides: [],
        contentType: [],
        contentEncoding: [],
        path: '/v1/messages',
        body: Readable.from([Buffer.from(body)]),
        declaredLength: Buffer.byteLength(body),
        signal: new AbortController().signal,
        held: () => {},
        bodyDeadlineMs: 1_000,
      })
      if (screened?.kind !== 'forward') throw new Error(`resend was not passed: ${screened?.kind}`)
      return screened
    }

    const first = await resend()
    first.undelivered()
    await resend()
    first.undelivered()

    expect(allowance(approvalId(0))).toMatchObject({ state: 'used' })
  })

  test.each(['request', 'upgrade'] as const)(
    'a screened %s whose client is gone before it is sent is handed back to the gate',
    async (kind) => {
      const tunnel = new AbortController()
      const undelivered = Promise.withResolvers<number>()
      let handedBack = 0
      const deps: ForwardDeps<object> = {
        upstream: { host: 'api.anthropic.com', address: '127.0.0.1', caPem: '' },
        inject: ({ path, headers }) => ({
          path,
          headers,
          account: { handle: accountHandle('anthropic', 'main'), service: 'anthropic-api' },
        }),
        gate: {
          screen: async () => {
            tunnel.abort()
            return {
              kind: 'forward',
              body: Buffer.alloc(0),
              undelivered: () => {
                handedBack++
              },
            }
          },
        },
      }
      const context = {
        principal: {},
        target: { host: 'api.anthropic.com', port: 443 },
        signal: tunnel.signal,
      }
      const server = createHttpServer(async (req, res) => {
        await forward(context, req, res, deps)
        undelivered.resolve(handedBack)
        res.destroy()
      })
      server.on('upgrade', async (req, client, head) => {
        await forwardUpgrade(context, req, client, head, deps)
        undelivered.resolve(handedBack)
        client.destroy()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      stops.push(() => {
        server.closeAllConnections()
        server.close()
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('server has no TCP address')

      httpRequest({
        port: address.port,
        host: '127.0.0.1',
        method: kind === 'request' ? 'POST' : 'GET',
        path: '/v1/stream',
        headers: {
          host: 'api.anthropic.com',
          ...(kind === 'upgrade' && { connection: 'Upgrade', upgrade: 'websocket' }),
        },
      })
        .on('error', () => {})
        .end()

      expect(await undelivered.promise).toBe(1)
    },
  )
})

test.each([false, true])(
  'upstream 401 invalidates the injection once without replay (upgrade=%s)',
  async (upgrade) => {
    const unauthorized = jest.fn(() => {})
    const inject = credentialInject({
      credentialFor: async (_principal, egress) => ({
        kind: 'inject',
        injection: {
          service: 'anthropic-api',
          handle: accountHandle('anthropic', 'main'),
          accountId: 'a1',
          apply: () => ({ path: egress.path, headers: egress.headers }),
          unauthorized,
          toJSON: () => {
            throw new Error('never serialize an injection')
          },
        },
      }),
    })
    const { upstream, tunnel } = await setupCredentials({ inject })
    upstream.setResponse('/v1/models', { status: 401, body: 'rejected' })
    const response = upgrade
      ? await exchangeRaw(
          tunnel.socket,
          'GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      : await sendTestRequest(tunnel, { method: 'GET', path: '/v1/models' })
    expect(response.status).toBe(401)
    expect(unauthorized).toHaveBeenCalledTimes(1)
    expect(upstream.requests).toHaveLength(1)
  },
)
