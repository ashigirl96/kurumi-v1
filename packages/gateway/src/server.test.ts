import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, jest, test } from 'bun:test'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

import { accountHandle, VaultError } from '@kurumi/account/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { createCertificateAuthority } from './ca.ts'
import {
  createEgressLog,
  gatewayContribution,
  gatewayStatus,
  loadCertificateAuthority,
  migrations,
  proxyEnv,
  stageCaBundle,
  startAgentPort,
  type EgressDecision,
  type EgressEvent,
  type EgressLog,
  type EgressPrincipal,
} from './server.ts'
import { openTestTunnel, sendTestRequest } from './testing.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-gateway-'))
  dirs.push(dir)
  return dir
}

function openDb(path = ':memory:') {
  const sqlite = new Database(path)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  return { db, sqlite }
}

const vaultKey = randomBytes(32)
const day = 24 * 60 * 60 * 1000
const ignore = () => {}

function notAfter(certPem: string): string {
  return new Date(Date.parse(new X509Certificate(certPem).validTo)).toISOString()
}

test('the CA is created once and every later load returns it', async () => {
  const { db, sqlite } = openDb()
  const first = await loadCertificateAuthority({ db, vaultKey, accountsStored: false, log: ignore })
  const second = await loadCertificateAuthority({
    db,
    vaultKey,
    accountsStored: false,
    log: ignore,
  })
  expect(second.certPem).toBe(first.certPem)
  expect(sqlite.query('SELECT count(*) AS n FROM gateway_ca').get()).toEqual({ n: 1 })
  expect(new X509Certificate(first.certPem).ca).toBe(true)
})

test('a reopened database yields the same CA, and its leaves chain to the first certificate', async () => {
  const path = join(tempDir(), 'kurumi.db')
  const before = openDb(path)
  const original = await loadCertificateAuthority({
    db: before.db,
    vaultKey,
    accountsStored: false,
    log: ignore,
  })
  before.sqlite.close()

  const after = openDb(path)
  const reloaded = await loadCertificateAuthority({
    db: after.db,
    vaultKey,
    accountsStored: false,
    log: ignore,
  })
  const leaf = new X509Certificate((await reloaded.leafFor('api.anthropic.com')).certPem)
  after.sqlite.close()

  expect(reloaded.certPem).toBe(original.certPem)
  expect(leaf.checkIssued(new X509Certificate(original.certPem))).toBe(true)
  expect(leaf.verify(new X509Certificate(original.certPem).publicKey)).toBe(true)
})

test('the stored key is sealed and, with accounts stored, does not open without the vault key', async () => {
  const { db, sqlite } = openDb()
  await loadCertificateAuthority({ db, vaultKey, accountsStored: false, log: ignore })
  const row = sqlite
    .query<{ sealed_key: Uint8Array }, []>('SELECT sealed_key FROM gateway_ca')
    .get()
  expect(Buffer.from(row?.sealed_key ?? []).toString('latin1')).not.toContain('PRIVATE KEY')
  const failure = await loadCertificateAuthority({
    db,
    vaultKey: randomBytes(32),
    accountsStored: true,
    log: ignore,
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(VaultError)
  expect(failure).toHaveProperty(
    'message',
    'sealed material for gateway_ca failed authentication, and accounts are stored, so the CA is not replaced under this key',
  )
})

test('with no accounts stored, a CA the vault key cannot open is replaced and the reason is logged', async () => {
  const { db, sqlite } = openDb()
  const original = await loadCertificateAuthority({
    db,
    vaultKey,
    accountsStored: false,
    log: ignore,
  })
  const newKey = randomBytes(32)
  const events: unknown[] = []
  const replaced = await loadCertificateAuthority({
    db,
    vaultKey: newKey,
    accountsStored: false,
    log: (event) => events.push(event),
  })

  expect(replaced.certPem).not.toBe(original.certPem)
  expect(events).toEqual([
    {
      kind: 'gateway.ca.replaced',
      reason:
        'the vault key cannot open the stored CA (sealed material for gateway_ca failed authentication) and no accounts are stored',
      notAfter: notAfter(replaced.certPem),
    },
  ])
  expect(sqlite.query('SELECT count(*) AS n FROM gateway_ca').get()).toEqual({ n: 1 })
  const reloaded = await loadCertificateAuthority({
    db,
    vaultKey: newKey,
    accountsStored: true,
    log: ignore,
  })
  expect(reloaded.certPem).toBe(replaced.certPem)
})

test.each([
  ['expired', 400],
  ['within 30 days of expiry', 340],
])('a stored CA that is %s is replaced at load and the renewal is logged', async (_, age) => {
  const { db, sqlite } = openDb()
  const start = Date.now()
  const original = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => start,
    accountsStored: false,
    log: ignore,
  })
  const later = start + age * day
  const events: unknown[] = []
  const renewed = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => later,
    accountsStored: false,
    log: (event) => events.push(event),
  })

  expect(renewed.certPem).not.toBe(original.certPem)
  expect(Date.parse(notAfter(renewed.certPem))).toBeGreaterThan(later + 300 * day)
  expect(events).toEqual([
    {
      kind: 'gateway.ca.renewed',
      previousNotAfter: notAfter(original.certPem),
      notAfter: notAfter(renewed.certPem),
    },
  ])
  expect(sqlite.query('SELECT count(*) AS n FROM gateway_ca').get()).toEqual({ n: 1 })
  const reloaded = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => later,
    accountsStored: false,
    log: ignore,
  })
  expect(reloaded.certPem).toBe(renewed.certPem)
  const leaf = new X509Certificate((await reloaded.leafFor('api.anthropic.com')).certPem)
  expect(leaf.checkIssued(new X509Certificate(renewed.certPem))).toBe(true)
})

test('a stored CA with more than 30 days left is kept', async () => {
  const { db } = openDb()
  const start = Date.now()
  const original = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => start,
    accountsStored: false,
    log: ignore,
  })
  const events: unknown[] = []
  const later = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => start + 330 * day,
    accountsStored: false,
    log: (event) => events.push(event),
  })
  expect(later.certPem).toBe(original.certPem)
  expect(events).toEqual([])
})

test('a loaded CA that outlives its end while the host runs logs gateway.ca.expired', async () => {
  const { db } = openDb()
  let now = Date.now()
  const events: unknown[] = []
  const ca = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => now,
    accountsStored: false,
    log: (event) => events.push(event),
  })
  now = Date.parse(notAfter(ca.certPem))
  const failure = await ca.leafFor('api.anthropic.com').catch((error: unknown) => error)
  expect(failure).toHaveProperty(
    'message',
    `the gateway CA expired at ${notAfter(ca.certPem)}; restart the host to renew it`,
  )
  expect(events).toEqual([{ kind: 'gateway.ca.expired', notAfter: notAfter(ca.certPem) }])
})

test('with accounts stored, an expired CA under a different vault key is refused, not replaced', async () => {
  const { db, sqlite } = openDb()
  const start = Date.now()
  const original = await loadCertificateAuthority({
    db,
    vaultKey,
    now: () => start,
    accountsStored: false,
    log: ignore,
  })
  const failure = await loadCertificateAuthority({
    db,
    vaultKey: randomBytes(32),
    now: () => start + 400 * day,
    accountsStored: true,
    log: ignore,
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(VaultError)
  expect(sqlite.query('SELECT cert_pem AS pem FROM gateway_ca').get()).toEqual({
    pem: original.certPem,
  })
})

test('the CA bundle holds the public roots and the CA under a content-addressed name', async () => {
  const home = tempDir()
  const ca = await createCertificateAuthority()
  const bundle = stageCaBundle(home, ca.certPem)
  const content = readFileSync(bundle.path, 'utf8')

  expect(bundle.path).toBe(join(home, 'ca', `combined-${bundle.sha}.pem`))
  expect(new Bun.CryptoHasher('sha256').update(content).digest('hex')).toBe(bundle.sha)
  expect(new X509Certificate(content).fingerprint256).toBe(
    new X509Certificate(ca.certPem).fingerprint256,
  )
  expect(content).toContain(rootCertificates[0]?.trim() ?? 'no roots')
  expect(statSync(bundle.path).mode & 0o777).toBe(0o644)
  expect(stageCaBundle(home, ca.certPem)).toEqual(bundle)

  const other = stageCaBundle(home, (await createCertificateAuthority()).certPem)
  expect(other.path).not.toBe(bundle.path)
})

test('the contribution points the container at the Agent Port and its CA bundle', () => {
  const caBundle = { path: '/home/ca/combined-abc.pem', sha: 'abc' }
  expect(gatewayContribution({ port: 4100, caBundle })).toEqual({
    env: {
      KURUMI_URL: 'http://host.docker.internal:4100',
      NO_PROXY: 'host.docker.internal,localhost,127.0.0.1,::1',
      no_proxy: 'host.docker.internal,localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: '/etc/kurumi/ca.pem',
      SSL_CERT_FILE: '/etc/kurumi/ca.pem',
    },
    mounts: [
      {
        hostPath: '/home/ca/combined-abc.pem',
        containerPath: '/etc/kurumi/ca.pem',
        readonly: true,
      },
    ],
  })
})

test('the proxy env carries the session token as the proxy password', () => {
  const proxy = 'http://s:token-1@host.docker.internal:4100'
  expect(proxyEnv({ port: 4100, sessionToken: 'token-1' })).toEqual({
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
  })
})

const injected: EgressDecision = {
  decision: 'injected',
  account: accountHandle('anthropic', 'main'),
  service: 'anthropic-api',
}

function egressEvent(
  overrides: Partial<Omit<EgressEvent<EgressPrincipal>, keyof EgressDecision>> = {},
  decision: EgressDecision = injected,
): EgressEvent<EgressPrincipal> {
  return {
    ...decision,
    principal: { agentGroupId: 'g1', sessionId: 's1' },
    at: Date.now(),
    host: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    durationMs: 12,
    ...overrides,
  }
}

const egressLogs: EgressLog[] = []
afterAll(() => {
  for (const log of egressLogs.splice(0)) log.stop()
})
afterEach(() => {
  jest.useRealTimers()
})

function startEgressLog(
  db: ReturnType<typeof openDb>['db'],
  options: Partial<Parameters<typeof createEgressLog>[0]> = {},
) {
  const log = createEgressLog({ db, log: ignore, ...options })
  egressLogs.push(log)
  return log
}

const countRows = (sqlite: Database) =>
  sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM egress_log').get()?.n

test('recorded requests reach egress_log together after the flush interval, not one by one', async () => {
  const { db, sqlite } = openDb()
  const log = startEgressLog(db, { flushMs: 50 })
  for (let index = 0; index < 3; index++) log.record(egressEvent())
  expect(countRows(sqlite)).toBe(0)
  await Bun.sleep(25)
  log.record(egressEvent())
  expect(countRows(sqlite)).toBe(0)
  await Bun.sleep(60)
  expect(countRows(sqlite)).toBe(4)
})

test('with no interval given, a recorded request reaches egress_log one second later', () => {
  jest.useFakeTimers()
  const { db, sqlite } = openDb()
  const log = startEgressLog(db)
  log.record(egressEvent())
  jest.advanceTimersByTime(999)
  expect(countRows(sqlite)).toBe(0)
  jest.advanceTimersByTime(1)
  expect(countRows(sqlite)).toBe(1)
})

test('steady traffic is written every second while it continues, not only after it stops', () => {
  jest.useFakeTimers()
  const { db, sqlite } = openDb()
  const log = startEgressLog(db)
  const counts: (number | undefined)[] = []
  for (let tick = 1; tick <= 30; tick++) {
    log.record(egressEvent())
    jest.advanceTimersByTime(100)
    if (tick % 10 === 0) counts.push(countRows(sqlite))
  }
  expect(counts).toEqual([10, 20, 30])
})

test('stopping the log writes what is still buffered, and later records are dropped', async () => {
  const { db, sqlite } = openDb()
  const log = startEgressLog(db, { flushMs: 20 })
  log.record(egressEvent())
  log.record(egressEvent({ status: 204 }, { decision: 'passed' }))
  expect(countRows(sqlite)).toBe(0)
  log.stop()
  expect(countRows(sqlite)).toBe(2)
  log.record(egressEvent())
  await Bun.sleep(40)
  expect(countRows(sqlite)).toBe(2)
})

test('rows older than 30 days are pruned at start and on each prune tick', async () => {
  const { db, sqlite } = openDb()
  let now = Date.now()
  const seed = startEgressLog(db, { now: () => now })
  seed.record(egressEvent({ at: now - 31 * day, path: '/old' }))
  seed.record(egressEvent({ at: now - 29 * day, path: '/recent' }))
  seed.stop()
  expect(countRows(sqlite)).toBe(2)

  const log = startEgressLog(db, { now: () => now, pruneEveryMs: 20 })
  const paths = () => log.rows({ limit: 10 }).map((row) => row.path)
  expect(paths()).toEqual(['/recent'])
  now += 2 * day
  await Bun.sleep(50)
  expect(paths()).toEqual([])
})

test('log rows filter by agent group, account, and decision, newest kept and printed oldest first', () => {
  const { db } = openDb()
  const log = startEgressLog(db, { flushMs: 60_000 })
  const at = Date.now()
  log.record(egressEvent({ at, path: '/1' }))
  log.record(
    egressEvent(
      { at: at + 1, path: '/2' },
      { ...injected, account: accountHandle('anthropic', 'second') },
    ),
  )
  log.record(
    egressEvent(
      { at: at + 2, path: '/3', status: 403 },
      { decision: 'refused', refusal: 'account_not_connected', service: 'anthropic-api' },
    ),
  )
  log.record(
    egressEvent({ at: at + 3, path: '/4', principal: { agentGroupId: 'g2', sessionId: 's2' } }),
  )
  const paths = (filter: Parameters<EgressLog['rows']>[0]) =>
    log.rows(filter).map((row) => row.path)

  expect(paths({ limit: 100 })).toEqual(['/1', '/2', '/3', '/4'])
  expect(paths({ limit: 2 })).toEqual(['/3', '/4'])
  expect(paths({ agentGroupId: 'g2', limit: 100 })).toEqual(['/4'])
  expect(paths({ account: 'anthropic/second', limit: 100 })).toEqual(['/2'])
  expect(paths({ decision: 'refused', limit: 100 })).toEqual(['/3'])
  expect(log.rows({ decision: 'refused', limit: 1 })[0]).toEqual({
    at: new Date(at + 2),
    agentGroupId: 'g1',
    sessionId: 's1',
    host: 'api.anthropic.com',
    method: 'POST',
    path: '/3',
    account: null,
    service: 'anthropic-api',
    decision: 'refused',
    refusal: 'account_not_connected',
    status: 403,
    durationMs: 12,
  })
})

test('a flush that fails is reported and the log keeps accepting records', () => {
  const { db, sqlite } = openDb()
  const events: unknown[] = []
  const log = startEgressLog(db, { flushMs: 60_000, log: (event) => events.push(event) })
  sqlite.run('DROP TABLE egress_log')
  log.record(egressEvent())
  expect(() => log.rows({ limit: 1 })).toThrow()
  expect(events).toEqual([
    expect.objectContaining({
      kind: 'gateway.egress_log.write_failed',
      operation: 'flush',
      rows: 1,
    }),
  ])
})

test('status reports admission, the Agent Port address, and the SHA-256 fingerprint of the CA', async () => {
  const ca = await createCertificateAuthority()
  const port = { host: '127.0.0.1', port: 4000 }
  expect(
    gatewayStatus({
      admission: { kind: 'open', port: 4000, openedAt: 0, bindToOpenMs: 1 },
      agentPort: port,
      caPem: ca.certPem,
    }),
  ).toEqual({
    admission: 'open',
    detail: null,
    agentPort: port,
    caFingerprint: new X509Certificate(ca.certPem).fingerprint256,
  })
  expect(
    gatewayStatus({
      admission: { kind: 'bind_failed', reason: { message: 'port in use', code: 'EADDRINUSE' } },
      agentPort: port,
      caPem: ca.certPem,
    }),
  ).toMatchObject({ admission: 'bind_failed', detail: 'port in use' })
})

async function until(condition: () => boolean) {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error('condition never held')
    await Bun.sleep(5)
  }
}

const anthropic = { host: 'api.anthropic.com', port: 443 }

type LoggedPortDeps = Parameters<typeof startAgentPort<EgressPrincipal>>[0]

async function startLoggedPort(
  forward: Partial<LoggedPortDeps['forward']> = {},
  deps: Partial<LoggedPortDeps> = {},
) {
  const ca = await createCertificateAuthority()
  const leaf = await ca.leafFor(anthropic.host)
  let received = 0
  const silent = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    tls: { key: leaf.keyPem, cert: leaf.certPem },
    fetch: () => {
      received++
      return new Promise<Response>(() => {})
    },
  })
  const { db, sqlite } = openDb()
  const log = startEgressLog(db, { flushMs: 60_000 })
  const port = await startAgentPort<EgressPrincipal>({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: () => ({ agentGroupId: 'g1', sessionId: 's1' }),
    intercepts: (host) => host === anthropic.host,
    ca,
    forward: {
      upstream: { ...anthropic, address: '127.0.0.1', port: silent.port, caPem: ca.certPem },
      inject: ({ path, headers }) => ({ path, headers }),
      log: log.record,
      ...forward,
    },
    ...deps,
  })
  const rowsAfterHostStop = async () => {
    await port.stop()
    log.stop()
    await silent.stop(true)
    return sqlite.query('SELECT method, path, decision, status FROM egress_log').all()
  }
  return { port, received: () => received, rowsAfterHostStop }
}

test('a request still waiting on upstream when the Agent Port stops is written by the log stop that follows', async () => {
  const { port, received, rowsAfterHostStop } = await startLoggedPort()
  const tunnel = await openTestTunnel({
    proxyPort: port.port,
    token: 't',
    caPem: port.caPem,
    target: anthropic,
  })
  sendTestRequest(tunnel, { path: '/v1/models' }).catch(ignore)
  await until(() => received() === 1)

  expect(await rowsAfterHostStop()).toEqual([
    expect.objectContaining({ method: 'GET', path: '/v1/models', decision: 'passed' }),
  ])
  tunnel.close()
})

test('a WebSocket upgrade still waiting on upstream when the Agent Port stops is written by the log stop that follows', async () => {
  const { port, received, rowsAfterHostStop } = await startLoggedPort()
  const tunnel = await openTestTunnel({
    proxyPort: port.port,
    token: 't',
    caPem: port.caPem,
    target: anthropic,
  })
  tunnel.socket.write(
    `GET /v1/stream HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  )
  await until(() => received() === 1)

  expect(await rowsAfterHostStop()).toEqual([
    expect.objectContaining({ method: 'GET', path: '/v1/stream', decision: 'passed' }),
  ])
  tunnel.close()
})

test('a request whose injection is still deciding when the Agent Port stops is written by the log stop that follows', async () => {
  let injecting = false
  const { port, rowsAfterHostStop } = await startLoggedPort({
    inject: async ({ path, headers }) => {
      injecting = true
      await Bun.sleep(50)
      return { path, headers }
    },
  })
  const tunnel = await openTestTunnel({
    proxyPort: port.port,
    token: 't',
    caPem: port.caPem,
    target: anthropic,
  })
  sendTestRequest(tunnel, { path: '/v1/models' }).catch(ignore)
  await until(() => injecting)

  expect(await rowsAfterHostStop()).toEqual([
    expect.objectContaining({ path: '/v1/models', decision: 'passed', status: null }),
  ])
  tunnel.close()
})

test('a CONNECT still resolving when the Agent Port stops is written as refused by the log stop that follows', async () => {
  let resolving = false
  const { port, rowsAfterHostStop } = await startLoggedPort(
    {},
    {
      resolve: async () => {
        resolving = true
        await Bun.sleep(50)
        return [{ address: '127.0.0.2', family: 4 }]
      },
      hostAddresses: () => [],
    },
  )
  const client = connect(port.port, '127.0.0.1')
  client.on('error', ignore)
  client.write(
    'CONNECT private.test:443 HTTP/1.1\r\nHost: private.test:443\r\n' +
      `Proxy-Authorization: Basic ${Buffer.from('s:t').toString('base64')}\r\n\r\n`,
  )
  await until(() => resolving)

  expect(await rowsAfterHostStop()).toEqual([
    expect.objectContaining({ method: 'CONNECT', path: 'private.test:443', decision: 'refused' }),
  ])
  client.destroy()
})
