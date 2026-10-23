import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

import { open, seal } from '@kurumi/account/server'
import type { Db } from '@kurumi/rpc/server'

import {
  certificateAuthority,
  certificateNotAfter,
  generateCaMaterial,
  type CertificateAuthority,
} from './ca.ts'
import { gatewayCa } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export { startAdmission } from './admission.ts'
export type { ForwardDeps, Injection, InjectionInput, UpstreamDestination } from './forward.ts'
export { startAgentPort, type AgentPort } from './port.ts'
export type { CertificateAuthority } from './ca.ts'

const CA_ROW = 1
const CA_SEAL_ID = 'gateway_ca'
const CA_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const CONTAINER_HOST = 'host.docker.internal'
const CONTAINER_CA_PATH = '/etc/kurumi/ca.pem'
const NO_PROXY = [CONTAINER_HOST, 'localhost', '127.0.0.1', '::1'].join(',')

export type CaRenewal = { kind: 'gateway.ca.renewed'; previousNotAfter: string; notAfter: string }

export async function loadCertificateAuthority(deps: {
  db: Db
  vaultKey: Uint8Array
  now?: () => number
  log(event: CaRenewal): void
}): Promise<CertificateAuthority> {
  const now = deps.now ?? Date.now
  const sealNewCa = async () => {
    const material = await generateCaMaterial({ now })
    const row = {
      certPem: material.certPem,
      sealedKey: seal(deps.vaultKey, CA_SEAL_ID, material.keyPem),
      createdAt: new Date(now()),
    }
    deps.db
      .insert(gatewayCa)
      .values({ id: CA_ROW, ...row })
      .onConflictDoUpdate({ target: gatewayCa.id, set: row })
      .run()
    return material
  }
  const row = deps.db.select().from(gatewayCa).get()
  if (!row) return certificateAuthority(await sealNewCa(), { now })
  const stored = { certPem: row.certPem, keyPem: open(deps.vaultKey, CA_SEAL_ID, row.sealedKey) }
  const previousNotAfter = certificateNotAfter(stored.certPem)
  if (previousNotAfter.getTime() - now() > CA_RENEWAL_WINDOW_MS) {
    return certificateAuthority(stored, { now })
  }
  const renewed = await sealNewCa()
  deps.log({
    kind: 'gateway.ca.renewed',
    previousNotAfter: previousNotAfter.toISOString(),
    notAfter: certificateNotAfter(renewed.certPem).toISOString(),
  })
  return certificateAuthority(renewed, { now })
}

export type CaBundle = { path: string; sha: string }

/**
 * `SSL_CERT_FILE` replaces the trust store of OpenSSL clients such as curl, so the bundle carries the public roots
 * next to the kurumi CA. The name is content-addressed because a running container pins the file it mounted.
 */
export function stageCaBundle(home: string, caPem: string): CaBundle {
  const content = `${[caPem.trim(), ...rootCertificates].join('\n')}\n`
  const sha = createHash('sha256').update(content).digest('hex')
  const directory = join(home, 'ca')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `combined-${sha}.pem`)
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
    const temporary = join(directory, `.pending-${randomUUID()}`)
    writeFileSync(temporary, content, { mode: 0o644 })
    renameSync(temporary, path)
  }
  return { path, sha }
}

export type GatewayContribution = {
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: true }[]
}

export function gatewayContribution(input: {
  port: number
  caBundle: CaBundle
}): GatewayContribution {
  return {
    env: {
      KURUMI_URL: `http://${CONTAINER_HOST}:${input.port}`,
      NO_PROXY,
      no_proxy: NO_PROXY,
      NODE_EXTRA_CA_CERTS: CONTAINER_CA_PATH,
      SSL_CERT_FILE: CONTAINER_CA_PATH,
    },
    mounts: [{ hostPath: input.caBundle.path, containerPath: CONTAINER_CA_PATH, readonly: true }],
  }
}

export function proxyEnv(input: { port: number; sessionToken: string }): Record<string, string> {
  const proxy = `http://s:${input.sessionToken}@${CONTAINER_HOST}:${input.port}`
  return { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy }
}
