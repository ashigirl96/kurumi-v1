import { afterEach, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:http'
import { connect, createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'

import { certificateAuthority, createCertificateAuthority, generateCaMaterial } from './ca.ts'
import { startAgentPort } from './port.ts'
import { openTestTunnel, sendTestRequest, startFakeUpstream, startTestGateway } from './testing.ts'

const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
})

test('a root-level lane can start both fixtures through the testing entry alone', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { startFakeUpstream, startTestGateway } from '@kurumi/gateway/testing'
    const upstream = await startFakeUpstream()
    const gateway = await startTestGateway({
      port: 0, token: 'lane-token', intercepts: new Set(['fake.test']), upstream: upstream.destination,
    })
    await gateway.stop()
    await upstream.stop()
  `,
    ],
    { cwd: join(import.meta.dir, '../../..'), timeout: 5000 },
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('gateway.started')
})

async function setup() {
  const upstream = await startFakeUpstream()
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

test.each([undefined, 'wrong-token'])(
  'CONNECT refuses token %s before upstream traffic',
  async (token) => {
    const { upstream, gateway } = await setup()
    const result = await new Promise<{ status: number | undefined; challenge: string | undefined }>(
      (resolve, reject) => {
        const req = request({
          host: '127.0.0.1',
          port: gateway.port,
          method: 'CONNECT',
          path: 'fake.test:443',
          headers: token
            ? { 'Proxy-Authorization': `Basic ${Buffer.from(`s:${token}`).toString('base64')}` }
            : {},
        })
        req.on('error', reject)
        req.on('connect', (response, socket) => {
          socket.destroy()
          resolve({
            status: response.statusCode,
            challenge: response.headers['proxy-authenticate'],
          })
        })
        req.end()
      },
    )
    expect(result.status).toBe(407)
    expect(result.challenge).toBe('Basic realm="kurumi"')
    expect(upstream.requests).toHaveLength(0)
  },
)

test('a rejected CONNECT releases a peer that keeps its write half open', async () => {
  const { gateway } = await setup()
  const client = connect({ host: '127.0.0.1', port: gateway.port, allowHalfOpen: true })
  client.on('error', () => client.destroy())
  stops.push(() => {
    client.destroy()
  })
  let response = ''
  client.on('data', (chunk: Buffer) => {
    response += chunk.toString()
  })
  await once(client, 'connect')
  const ended = once(client, 'end')
  client.write('CONNECT fake.test:443 HTTP/1.1\r\nHost: fake.test\r\n\r\n')
  await ended
  expect(response).toContain('407 Proxy Authentication Required')
  const closed = new Promise<void>((resolve) => {
    client.once('close', () => resolve())
  })
  client.write('still writing after rejection')
  await closed
  expect(client.destroyed).toBe(true)
})

test('one MITM tunnel injects both keep-alive requests', async () => {
  const { upstream, gateway } = await setup()
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  expect(tunnel.socket.getPeerCertificate().subjectaltname).toBe('DNS:fake.test')
  const first = await sendTestRequest(tunnel, { path: '/echo' })
  const second = await sendTestRequest(tunnel, { path: '/echo?second=1' })
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(upstream.requests.map((entry) => entry.headers['x-injected'])).toEqual(['yes', 'yes'])
  expect(gateway.connects).toEqual([{ host: 'fake.test', port: 443 }])
})

test('an unintercepted public address keeps the upstream certificate and receives no injection', async () => {
  const upstream = await startFakeUpstream({ host: '127.0.0.1' })
  stops.push(upstream.stop)
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? {} : null),
    intercepts: () => false,
    addressRefusal: () => null,
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: upstream.caPem,
    target: { host: '127.0.0.1', port: upstream.port },
  })
  stops.push(tunnel.close)
  expect(tunnel.socket.getPeerCertificate().raw.toString('base64')).toBe(
    upstream.certificate.raw.toString('base64'),
  )
  expect((await sendTestRequest(tunnel, { path: '/echo' })).status).toBe(200)
  expect(upstream.requests[0]?.headers['x-injected']).toBeUndefined()
})

async function rawConnect(proxyPort: number, authority: string): Promise<string> {
  const client = connect({ host: '127.0.0.1', port: proxyPort })
  stops.push(() => {
    client.destroy()
  })
  let response = ''
  client.on('data', (chunk: Buffer) => {
    response += chunk.toString()
  })
  await once(client, 'connect')
  const answered = new Promise<void>((resolve) => {
    client.on('data', () => {
      if (response.includes('\r\n\r\n')) resolve()
    })
    client.once('close', () => resolve())
  })
  const credential = Buffer.from('s:test-token').toString('base64')
  client.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
  )
  await answered
  return response
}

async function countingService() {
  const service = createServer((socket) => socket.destroy())
  const state = { accepts: 0, port: 0 }
  service.on('connection', () => state.accepts++)
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  stops.push(() => new Promise<void>((resolve) => service.close(() => resolve())))
  state.port = (service.address() as AddressInfo).port
  return state
}

async function gatewayResolving(addresses: string[], refused: string[]) {
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? {} : null),
    intercepts: () => false,
    addressRefusal: (address) => (refused.includes(address) ? 'test-refused' : null),
    resolve: (host) =>
      Promise.resolve(
        host === 'pinned.test'
          ? addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
          : [],
      ),
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
  })
  stops.push(gateway.stop)
  return gateway
}

test('a tunnel dials the address the check approved, not a second lookup of the name', async () => {
  const service = await countingService()
  const gateway = await gatewayResolving(['127.0.0.1'], [])
  const response = await rawConnect(gateway.port, `pinned.test:${service.port}`)
  expect(response).toStartWith('HTTP/1.1 200 Connection Established')
  await Bun.sleep(50)
  expect(service.accepts).toBe(1)
})

test('a name with one approved and one refused address is refused before any connection', async () => {
  const service = await countingService()
  const gateway = await gatewayResolving(['127.0.0.1', '::1'], ['::1'])
  const response = await rawConnect(gateway.port, `pinned.test:${service.port}`)
  expect(response).toStartWith('HTTP/1.1 403 Forbidden')
  expect(response).toContain('pinned.test: it resolves to a test-refused address')
  expect(response).not.toContain('::1')
  await Bun.sleep(50)
  expect(service.accepts).toBe(0)
})

test.each([
  ['127.0.0.1', 'loopback'],
  ['localhost', 'loopback'],
  ['[::ffff:127.0.0.1]', 'loopback'],
  ['0.0.0.0', 'unspecified'],
])('CONNECT to %s on the host is refused as %s before any connection', async (host, reason) => {
  const { gateway } = await setup()
  const service = await countingService()

  const response = await rawConnect(gateway.port, `${host}:${service.port}`)

  expect(response).toStartWith('HTTP/1.1 403 Forbidden')
  expect(response).toContain(`a ${reason} address`)
  await Bun.sleep(50)
  expect(service.accepts).toBe(0)
})

test.each([
  ['10.0.0.1:443', 'private'],
  ['192.168.65.254:443', 'private'],
  ['100.64.0.1:443', 'carrier-grade NAT'],
  ['169.254.169.254:80', 'link-local'],
  ['[fe80::1]:443', 'link-local'],
  ['[fc00::1]:443', 'unique local'],
  ['[::1]:443', 'loopback'],
  ['224.0.0.1:443', 'multicast'],
])('CONNECT to %s is refused as %s', async (authority, reason) => {
  const { gateway } = await setup()
  const response = await rawConnect(gateway.port, authority)
  expect(response).toStartWith('HTTP/1.1 403 Forbidden')
  expect(response).toContain(`a ${reason} address`)
})

test('CONNECT to a name that resolves to an address of a host interface is refused before connecting', async () => {
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? {} : null),
    intercepts: () => false,
    hostAddresses: () => ['203.0.113.7'],
    resolve: () => Promise.resolve([{ address: '203.0.113.7', family: 4 }]),
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
  })
  stops.push(gateway.stop)

  const response = await rawConnect(gateway.port, 'own.test:443')

  expect(response).toStartWith('HTTP/1.1 403 Forbidden')
  expect(response).toContain('own.test: it resolves to a host interface address')
})

test('CONNECT to an intercepted host after the CA has expired is refused with the reason', async () => {
  const material = await generateCaMaterial()
  const end = Date.parse(new X509Certificate(material.certPem).validTo)
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (token === 'test-token' ? {} : null),
    intercepts: () => true,
    ca: await certificateAuthority(material, { now: () => end }),
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
  })
  stops.push(gateway.stop)

  const response = await rawConnect(gateway.port, 'fake.test:443')

  expect(response).toStartWith('HTTP/1.1 502 Bad Gateway')
  expect(response).toContain(`the gateway CA expired at ${new Date(end).toISOString()}`)
})

test('concurrent tunnels on the same host retain distinct principals and destination ports', async () => {
  const ca = await createCertificateAuthority()
  const first = await startFakeUpstream({ ca })
  const second = await startFakeUpstream({ ca })
  stops.push(first.stop, second.stop)
  const tokens = new Set(['first', 'second'])
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => (tokens.has(token) ? { name: token } : null),
    intercepts: () => true,
    forward: {
      upstream: { host: 'fake.test', address: '127.0.0.1', caPem: ca.certPem },
      inject: ({ principal, path, headers }) => {
        headers.set('x-principal', principal.name)
        return { path, headers }
      },
    },
  })
  stops.push(gateway.stop)
  const tunnels = await Promise.all(
    [first, second].map((upstream, index) =>
      openTestTunnel({
        proxyPort: gateway.port,
        token: index === 0 ? 'first' : 'second',
        caPem: gateway.caPem,
        target: { host: 'fake.test', port: upstream.port },
      }),
    ),
  )
  for (const tunnel of tunnels) stops.push(tunnel.close)
  await Promise.all(tunnels.map((tunnel) => sendTestRequest(tunnel, { path: '/echo' })))
  expect(first.requests.map((entry) => entry.headers['x-principal'])).toEqual(['first'])
  expect(second.requests.map((entry) => entry.headers['x-principal'])).toEqual(['second'])
  tokens.delete('first')
  const revoked = await sendTestRequest(tunnels[0]!, { path: '/echo' })
  expect(revoked.status).toBe(407)
  expect(first.requests).toHaveLength(1)
  expect((await sendTestRequest(tunnels[1]!, { path: '/echo' })).status).toBe(200)
})

test('injection receives original raw header lines and an unnormalized path', async () => {
  const upstream = await startFakeUpstream()
  stops.push(upstream.stop)
  let rawHeaders: readonly string[] = []
  let pathSeen = ''
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: () => ({}),
    intercepts: () => true,
    forward: {
      upstream: upstream.destination,
      inject: ({ path, headers, rawHeaders: raw }) => {
        pathSeen = path
        rawHeaders = raw
        return { path, headers }
      },
    },
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  const response = once(tunnel.socket, 'data')
  tunnel.socket.write(
    'GET /one/../echo?access_token=x%2Fy HTTP/1.1\r\nHost: fake.test\r\nAuthorization: Bearer first\r\nauthorization: Bearer second\r\nConnection: close\r\n\r\n',
  )
  await response
  expect(rawHeaders).toEqual([
    'Host',
    'fake.test',
    'Authorization',
    'Bearer first',
    'authorization',
    'Bearer second',
    'Connection',
    'close',
  ])
  expect(pathSeen).toBe('/one/../echo?access_token=x%2Fy')
})

test('a conflicting inner authority cannot change the credential destination', async () => {
  const { upstream, gateway } = await setup()
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  const response = await sendTestRequest(tunnel, { path: '/echo', headers: { host: 'other.test' } })
  expect(response.status).toBe(400)
  expect(upstream.requests).toHaveLength(0)
})

test('stop closes an active tunnel and is repeatable', async () => {
  const { gateway } = await setup()
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  const closed = new Promise<void>((resolve) => {
    tunnel.socket.once('close', () => resolve())
  })
  await gateway.stop()
  await closed
  await gateway.stop()
  expect(tunnel.socket.destroyed).toBe(true)
})

test('malformed inner HTTP closes the tunnel', async () => {
  const { gateway } = await setup()
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  const closed = once(tunnel.socket, 'close')
  tunnel.socket.write('not-an-http-request\r\n\r\n')
  await closed
  expect(tunnel.socket.destroyed).toBe(true)
})

test('new tunnels receive a refreshed leaf while the existing tunnel stays usable', async () => {
  const upstream = await startFakeUpstream()
  stops.push(upstream.stop)
  const ca = await createCertificateAuthority()
  let leaf = await ca.mintLeaf('fake.test')
  const gateway = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    ca: { ...ca, leafFor: () => Promise.resolve(leaf) },
    authenticate: () => ({}),
    intercepts: () => true,
    forward: { upstream: upstream.destination, inject: ({ path, headers }) => ({ path, headers }) },
  })
  stops.push(gateway.stop)
  const first = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'token',
    caPem: gateway.caPem,
  })
  stops.push(first.close)
  expect((await sendTestRequest(first, { path: '/echo' })).status).toBe(200)
  leaf = await ca.mintLeaf('fake.test')
  const second = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'token',
    caPem: gateway.caPem,
  })
  stops.push(second.close)
  expect(second.socket.getPeerCertificate().fingerprint256).not.toBe(
    first.socket.getPeerCertificate().fingerprint256,
  )
  expect(second.socket.alpnProtocol).toBe('http/1.1')
  expect((await sendTestRequest(first, { path: '/echo' })).status).toBe(200)
  expect((await sendTestRequest(second, { path: '/echo' })).status).toBe(200)
})
