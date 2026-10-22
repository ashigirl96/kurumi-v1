import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { request } from 'node:https'

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
