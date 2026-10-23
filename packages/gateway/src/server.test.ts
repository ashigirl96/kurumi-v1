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

test('the CA is created once and every later load returns it', async () => {
  const { db, sqlite } = openDb()
  const first = await loadCertificateAuthority({ db, vaultKey })
  const second = await loadCertificateAuthority({ db, vaultKey })
  expect(second.certPem).toBe(first.certPem)
  expect(sqlite.query('SELECT count(*) AS n FROM gateway_ca').get()).toEqual({ n: 1 })
  expect(new X509Certificate(first.certPem).ca).toBe(true)
})

test('a reopened database yields the same CA, and its leaves chain to the first certificate', async () => {
  const path = join(tempDir(), 'kurumi.db')
  const before = openDb(path)
  const original = await loadCertificateAuthority({ db: before.db, vaultKey })
  before.sqlite.close()

  const after = openDb(path)
  const reloaded = await loadCertificateAuthority({ db: after.db, vaultKey })
  const leaf = new X509Certificate((await reloaded.leafFor('api.anthropic.com')).certPem)
  after.sqlite.close()

  expect(reloaded.certPem).toBe(original.certPem)
  expect(leaf.checkIssued(new X509Certificate(original.certPem))).toBe(true)
  expect(leaf.verify(new X509Certificate(original.certPem).publicKey)).toBe(true)
})

test('the stored key is sealed and does not open without the vault key', async () => {
  const { db, sqlite } = openDb()
  await loadCertificateAuthority({ db, vaultKey })
  const row = sqlite
    .query<{ sealed_key: Uint8Array }, []>('SELECT sealed_key FROM gateway_ca')
    .get()
  expect(Buffer.from(row?.sealed_key ?? []).toString('latin1')).not.toContain('PRIVATE KEY')
  const failure = await loadCertificateAuthority({ db, vaultKey: randomBytes(32) }).catch(
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(VaultError)
})

test('the CA bundle holds the public roots and the CA under a content-addressed name', async () => {
  const home = tempDir()
  const ca = await createCertificateAuthority()
  const bundle = stageCaBundle(home, ca.certPem)
  const content = readFileSync(bundle.path, 'utf8')

  expect(bundle.path).toBe(join(home, 'ca', `combined-${bundle.sha}.pem`))
  expect(new Bun.CryptoHasher('sha256').update(content).digest('hex')).toBe(bundle.sha)
  expect(content).toContain(ca.certPem.trim())
  expect(content).toContain(rootCertificates[0]?.trim() ?? 'no roots')
  expect(statSync(bundle.path).mode & 0o777).toBe(0o644)
  expect(stageCaBundle(home, ca.certPem)).toEqual(bundle)

  const other = stageCaBundle(home, (await createCertificateAuthority()).certPem)
  expect(other.path).not.toBe(bundle.path)
})

test('the contribution sends container egress through the Agent Port with the session token', () => {
  const caBundle = { path: '/home/ca/combined-abc.pem', sha: 'abc' }
  const proxy = 'http://s:token-1@host.docker.internal:4100'
  expect(gatewayContribution({ port: 4100, caBundle, sessionToken: 'token-1' })).toEqual({
    env: {
      KURUMI_URL: 'http://host.docker.internal:4100',
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      NO_PROXY: 'host.docker.internal',
      no_proxy: 'host.docker.internal',
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
