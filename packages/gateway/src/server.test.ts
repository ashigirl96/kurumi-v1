import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

import { VaultError } from '@kurumi/account/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { createCertificateAuthority } from './ca.ts'
import {
  gatewayContribution,
  loadCertificateAuthority,
  migrations,
  proxyEnv,
  stageCaBundle,
} from './server.ts'

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
