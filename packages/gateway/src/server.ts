import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

import { open, seal } from '@kurumi/account/server'
import type { Db } from '@kurumi/rpc/server'

import { certificateAuthority, generateCaMaterial, type CertificateAuthority } from './ca.ts'
import { gatewayCa } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export { startAdmission } from './admission.ts'
export type { ForwardDeps, Injection, InjectionInput, UpstreamDestination } from './forward.ts'
export { startAgentPort, type AgentPort } from './port.ts'
export type { CertificateAuthority } from './ca.ts'

const CA_ROW = 1
const CA_SEAL_ID = 'gateway_ca'
const CONTAINER_HOST = 'host.docker.internal'
const CONTAINER_CA_PATH = '/etc/kurumi/ca.pem'
const NO_PROXY = [CONTAINER_HOST, 'localhost', '127.0.0.1', '::1'].join(',')

export async function loadCertificateAuthority(deps: {
  db: Db
  vaultKey: Uint8Array
  now?: () => number
}): Promise<CertificateAuthority> {
  const create = async () => {
    const material = await generateCaMaterial({ now: deps.now })
    return deps.db
      .insert(gatewayCa)
      .values({
        id: CA_ROW,
        certPem: material.certPem,
        sealedKey: seal(deps.vaultKey, CA_SEAL_ID, material.keyPem),
        createdAt: new Date(deps.now?.() ?? Date.now()),
      })
      .returning()
      .get()
  }
  const row = deps.db.select().from(gatewayCa).get() ?? (await create())
  return certificateAuthority(
    { certPem: row.certPem, keyPem: open(deps.vaultKey, CA_SEAL_ID, row.sealedKey) },
    { now: deps.now },
  )
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
