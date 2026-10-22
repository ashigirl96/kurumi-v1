import { expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'

import { createCertificateAuthority } from './ca.ts'

test('a P-256 leaf names its host and chains to the gateway CA', async () => {
  const ca = await createCertificateAuthority()
  const leaf = await ca.leafFor('fake.test')
  const certificate = new X509Certificate(leaf.certPem)
  const issuer = new X509Certificate(ca.certPem)

  expect(certificate.checkHost('fake.test')).toBe('fake.test')
  expect(certificate.checkHost('other.test')).toBeUndefined()
  expect(certificate.checkIssued(issuer)).toBe(true)
  expect(certificate.verify(issuer.publicKey)).toBe(true)
  expect(certificate.publicKey.asymmetricKeyType).toBe('ec')
  expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
  expect(issuer.ca).toBe(true)
  expect(certificate.ca).toBe(false)
})

test('concurrent requests share one host context for 24 hours', async () => {
  let now = Date.now()
  const ca = await createCertificateAuthority({ now: () => now })
  const [first, concurrent] = await Promise.all([ca.leafFor('fake.test'), ca.leafFor('fake.test')])
  expect(concurrent.context).toBe(first.context)
  now += 24 * 60 * 60 * 1000 - 1
  expect((await ca.leafFor('fake.test')).context).toBe(first.context)
  now += 1
  const renewed = await ca.leafFor('fake.test')
  expect(renewed.context).not.toBe(first.context)
  expect(renewed.certPem).not.toBe(first.certPem)
})

test('uncached leaf creation and different hosts produce distinct leaves', async () => {
  const ca = await createCertificateAuthority()
  const first = await ca.mintLeaf('fake.test')
  const next = await ca.mintLeaf('fake.test')
  const other = await ca.leafFor('other.test')
  expect(next.certPem).not.toBe(first.certPem)
  expect(new X509Certificate(other.certPem).checkHost('other.test')).toBe('other.test')
  expect(new X509Certificate(other.certPem).checkHost('fake.test')).toBeUndefined()
})

test('an IP leaf has an IP SAN', async () => {
  const ca = await createCertificateAuthority()
  const leaf = await ca.leafFor('127.0.0.1')
  expect(new X509Certificate(leaf.certPem).checkIP('127.0.0.1')).toBe('127.0.0.1')
})
