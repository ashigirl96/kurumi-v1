// oxlint-disable-next-line import/no-unassigned-import -- @peculiar/x509 needs the metadata polyfill before evaluation.
import 'reflect-metadata'
import { isIP } from 'node:net'
import { createSecureContext, type SecureContext } from 'node:tls'

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509'

const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const day = 24 * 60 * 60 * 1000

export type Leaf = {
  certPem: string
  keyPem: string
  context: SecureContext
}

export type CertificateAuthority = {
  certPem: string
  mintLeaf(host: string): Promise<Leaf>
  leafFor(host: string): Promise<Leaf>
}

export type CaMaterial = { certPem: string; keyPem: string }

type Clock = { now?: () => number }

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey('pkcs8', key)
  const base64 = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`
}

export async function generateCaMaterial({ now = Date.now }: Clock = {}): Promise<CaMaterial> {
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=kurumi CA',
    notBefore: new Date(now() - 60_000),
    notAfter: new Date(now() + 365 * day),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  return { certPem: certificate.toString('pem'), keyPem: await pkcs8Pem(keys.privateKey) }
}

export function certificateNotAfter(certPem: string): Date {
  return new X509Certificate(certPem).notAfter
}

export async function certificateAuthority(
  material: CaMaterial,
  { now = Date.now }: Clock = {},
): Promise<CertificateAuthority> {
  const certificate = new X509Certificate(material.certPem)
  const der = Buffer.from(material.keyPem.replace(/-----[^-]+-----|\s/g, ''), 'base64')
  const signingKey = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign'])
  const cache = new Map<string, { expiresAt: number; leaf: Promise<Leaf> }>()

  async function mintLeaf(host: string): Promise<Leaf> {
    const leafKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
    const serial = crypto.getRandomValues(new Uint8Array(16))
    serial[0] = 1
    const leaf = await X509CertificateGenerator.create({
      serialNumber: Buffer.from(serial).toString('hex'),
      subject: 'CN=kurumi leaf',
      issuer: certificate.subject,
      notBefore: new Date(now() - 60_000),
      notAfter: new Date(Math.min(now() + 7 * day, certificate.notAfter.getTime())),
      signingAlgorithm: algorithm,
      publicKey: leafKeys.publicKey,
      signingKey,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([{ type: isIP(host) ? 'ip' : 'dns', value: host }]),
        await AuthorityKeyIdentifierExtension.create(certificate),
      ],
    })
    const keyPem = await pkcs8Pem(leafKeys.privateKey)
    const certPem = leaf.toString('pem')
    return { certPem, keyPem, context: createSecureContext({ key: keyPem, cert: certPem }) }
  }

  function leafFor(host: string): Promise<Leaf> {
    const cached = cache.get(host)
    if (cached && cached.expiresAt > now()) return cached.leaf
    const leaf = mintLeaf(host).catch((error: unknown) => {
      if (cache.get(host)?.leaf === leaf) cache.delete(host)
      throw error
    })
    cache.set(host, { expiresAt: now() + day, leaf })
    return leaf
  }

  return { certPem: material.certPem, mintLeaf, leafFor }
}

export async function createCertificateAuthority(clock: Clock = {}): Promise<CertificateAuthority> {
  return certificateAuthority(await generateCaMaterial(clock), clock)
}
