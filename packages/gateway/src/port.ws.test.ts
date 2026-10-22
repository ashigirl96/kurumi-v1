import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'

import { startAgentPort } from './port.ts'
import {
  openTestTunnel,
  startFakeStreamUpstream,
  startFakeUpstream,
  startTestGateway,
} from './testing.ts'

const websocketKey = randomBytes(16).toString('base64')

const WebSocketClient = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket & Pick<Bun.WebSocket, 'terminate'>
}

const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
})

async function setup() {
  const upstream = await startFakeStreamUpstream()
  stops.push(upstream.stop)
  const gateway = await startTestGateway({
    port: 0,
    token: 'test-token',
    intercepts: new Set(['fake.test']),
    upstream: upstream.destination,
  })
  stops.push(gateway.stop)
  return { upstream, gateway }
}

function connect(gateway: { port: number; caPem: string }, path = '/ws') {
  const socket = new WebSocketClient(`wss://fake.test${path}`, {
    proxy: `http://s:test-token@127.0.0.1:${gateway.port}`,
    tls: { ca: gateway.caPem },
    headers: { 'proxy-authorization': 'Basic must-not-reach-upstream', 'x-client': 'kept' },
  })
  stops.push(() => socket.terminate())
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket handshake failed')), {
      once: true,
    })
  })
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener('close', resolve, { once: true }),
  )
  return { socket, opened, closed }
}

test('100 WebSocket echoes keep order, inject the handshake, and relay a client close code', async () => {
  const { upstream, gateway } = await setup()
  const { socket, opened, closed } = connect(gateway)
  await opened
  for (let index = 0; index < 100; index++) {
    const reply = new Promise<unknown>((resolve) =>
      socket.addEventListener('message', (event) => resolve(event.data), { once: true }),
    )
    socket.send(`message-${index}`)
    expect(await reply).toBe(`message-${index}`)
  }
  expect(upstream.webSockets[0]?.headers.get('x-injected')).toBe('yes')
  expect(upstream.webSockets[0]?.headers.get('x-client')).toBe('kept')
  expect(upstream.webSockets[0]?.headers.get('proxy-authorization')).toBeNull()
  socket.close(4002, 'client close')
  expect((await closed).code).toBe(4002)
  for (let attempt = 0; attempt < 100 && upstream.webSockets[0]?.closeCode === null; attempt++)
    await delay(10)
  expect(upstream.webSockets[0]?.closeCode).toBe(4002)
})

test('an upstream WebSocket close code reaches the client', async () => {
  const { gateway } = await setup()
  const { opened, closed } = connect(gateway, '/ws?closeCode=4001')
  await opened
  expect((await closed).code).toBe(4001)
})

test('stopping the gateway closes an upgraded upstream socket', async () => {
  const { upstream, gateway } = await setup()
  const { opened, closed } = connect(gateway)
  await opened
  await gateway.stop()
  await closed
  for (let attempt = 0; attempt < 100 && upstream.webSockets[0]?.closeCode === null; attempt++)
    await delay(10)
  expect(upstream.webSockets[0]?.closeCode).not.toBeNull()
})

test.each(['revoked', 'conflicting-host'])(
  'an upgrade with %s cannot reach the upstream',
  async (mode) => {
    const upstream = await startFakeStreamUpstream()
    stops.push(upstream.stop)
    let valid = true
    const gateway = await startAgentPort({
      bind: { host: '127.0.0.1', port: 0 },
      authenticate: () => (valid ? {} : null),
      intercepts: () => true,
      forward: {
        upstream: upstream.destination,
        inject: ({ path, headers }) => ({ path, headers }),
      },
    })
    stops.push(gateway.stop)
    const tunnel = await openTestTunnel({
      proxyPort: gateway.port,
      token: 'test-token',
      caPem: gateway.caPem,
    })
    stops.push(tunnel.close)
    valid = mode !== 'revoked'
    const client = request({
      hostname: 'fake.test',
      path: '/ws',
      agent: tunnel.agent,
      headers: {
        host: mode === 'conflicting-host' ? 'other.test' : 'fake.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': websocketKey,
        'sec-websocket-version': '13',
      },
    })
    const response = once(client, 'response')
    client.end()
    const [res] = await response
    res.resume()
    expect(res.statusCode).toBe(mode === 'revoked' ? 407 : 400)
    expect(upstream.webSockets).toHaveLength(0)
  },
)

test('an upstream upgrade refusal keeps its status and body', async () => {
  const upstream = await startFakeUpstream()
  stops.push(upstream.stop)
  upstream.setResponse('/refuse', { status: 403, body: 'upgrade denied' })
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
  const client = request({
    hostname: 'fake.test',
    path: '/refuse',
    agent: tunnel.agent,
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  })
  const response = once(client, 'response')
  client.end()
  const [res] = await response
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  await once(res, 'end')
  expect(res.statusCode).toBe(403)
  expect(Buffer.concat(chunks).toString()).toBe('upgrade denied')
})

test('an upgrade preserves a WebSocket frame sent with the request headers', async () => {
  const { gateway } = await setup()
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  const frame = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 100, 99, 113, 104, 120])
  const expected = Buffer.from([0x81, 5, ...Buffer.from('early')])
  const echoed = new Promise<Buffer>((resolve, reject) => {
    let received = Buffer.alloc(0)
    tunnel.socket.on('error', reject)
    tunnel.socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.includes(expected)) resolve(received)
    })
  })
  tunnel.socket.write(
    Buffer.concat([
      Buffer.from(
        `GET /ws HTTP/1.1\r\nHost: fake.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
      frame,
    ]),
  )
  expect((await echoed).toString()).toStartWith('HTTP/1.1 101')
})

test.each([{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }])(
  'an upgrade with body framing is rejected',
  async (framing) => {
    const { upstream, gateway } = await setup()
    const tunnel = await openTestTunnel({
      proxyPort: gateway.port,
      token: 'test-token',
      caPem: gateway.caPem,
    })
    stops.push(tunnel.close)
    const response = once(tunnel.socket, 'data')
    const fields = Object.entries(framing)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('')
    tunnel.socket.write(
      `GET /ws HTTP/1.1\r\nHost: fake.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n${fields}\r\n`,
    )
    const [data] = await response
    expect(data.toString()).toStartWith('HTTP/1.1 400')
    expect(upstream.webSockets).toHaveLength(0)
  },
)
