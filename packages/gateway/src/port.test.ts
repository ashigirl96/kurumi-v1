import { afterEach, expect, test } from 'bun:test'
import { once } from 'node:events'
import { request } from 'node:http'

import { createCertificateAuthority } from './ca.ts'
import { startAgentPort } from './port.ts'
import { openTestTunnel, sendTestRequest, startFakeUpstream, startTestGateway } from './testing.ts'

const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
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

test('an unintercepted host keeps the upstream certificate and receives no injection', async () => {
  const upstream = await startFakeUpstream({ host: '127.0.0.1' })
  stops.push(upstream.stop)
  const gateway = await startTestGateway({ port: 0, token: 'test-token', intercepts: new Set() })
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
