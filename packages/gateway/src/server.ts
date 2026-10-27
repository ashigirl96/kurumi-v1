import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

import { open, seal, VaultError } from '@kurumi/account/server'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import type { AdmissionState } from './admission.ts'
import {
  certificateAuthority,
  certificateNotAfter,
  generateCaMaterial,
  type CaExpired,
  type CertificateAuthority,
} from './ca.ts'
import { contract, type GatewayStatus } from './contract.ts'
import type { EgressLog } from './egress-log.ts'
import type { RuleStore } from './rules.ts'
import { gatewayCa } from './schema.ts'

export { migrations } from '../migrations/index.ts'
export { startAdmission } from './admission.ts'
export { createEgressLog, type EgressLog, type EgressPrincipal } from './egress-log.ts'
export { credentialInject } from './forward.ts'
export {
  ALLOWANCE_MS,
  createEgressApproval,
  HOLD_MS,
  MAX_HELD_BODY_BYTES,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_PER_GROUP,
  MAX_UNDECIDED_PER_GROUP,
  type EgressApproval,
  type GatewayApprovals,
  type SessionNotice,
} from './hold.ts'
export type {
  EgressDecision,
  EgressEvent,
  EgressGate,
  ForwardDeps,
  Forwarded,
  InjectionInput,
  ScreenInput,
  Screened,
  UpstreamDestination,
} from './forward.ts'
export { startAgentPort, type AgentPort } from './port.ts'
export { REFUSAL_STATUS, type GatewayRefusal, type HoldRefusal } from './refusal.ts'
export type { RuleStore } from './rules.ts'
export type { CertificateAuthority } from './ca.ts'

const CA_ROW = 1
const CA_SEAL_ID = 'gateway_ca'
const CA_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const CONTAINER_HOST = 'host.docker.internal'
const CONTAINER_CA_PATH = '/etc/kurumi/ca.pem'
const NO_PROXY = [CONTAINER_HOST, 'localhost', '127.0.0.1', '::1'].join(',')

export type CaEvent =
  | { kind: 'gateway.ca.renewed'; previousNotAfter: string; notAfter: string }
  | { kind: 'gateway.ca.replaced'; reason: string; notAfter: string }
  | CaExpired

function openCaKey(vaultKey: Uint8Array, sealedKey: Uint8Array): string | VaultError {
  try {
    return open(vaultKey, CA_SEAL_ID, sealedKey)
  } catch (error) {
    if (error instanceof VaultError) return error
    throw error
  }
}

export async function loadCertificateAuthority(deps: {
  db: Db
  vaultKey: Uint8Array
  accountsStored: boolean
  now?: () => number
  log: (event: CaEvent) => void
}): Promise<CertificateAuthority> {
  const now = deps.now ?? Date.now
  const clock = { now, log: deps.log }
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
  if (!row) return certificateAuthority(await sealNewCa(), clock)
  const opened = openCaKey(deps.vaultKey, row.sealedKey)
  if (opened instanceof VaultError) {
    if (deps.accountsStored) {
      throw new VaultError(
        `${opened.message}, and accounts are stored, so the CA is not replaced under this key`,
        { cause: opened },
      )
    }
    const replaced = await sealNewCa()
    deps.log({
      kind: 'gateway.ca.replaced',
      reason: `the vault key cannot open the stored CA (${opened.message}) and no accounts are stored`,
      notAfter: certificateNotAfter(replaced.certPem).toISOString(),
    })
    return certificateAuthority(replaced, clock)
  }
  const stored = { certPem: row.certPem, keyPem: opened }
  const previousNotAfter = (() => {
    try {
      return certificateNotAfter(stored.certPem)
    } catch (error) {
      throw new CaUnreadableError('the stored gateway CA certificate cannot be parsed', {
        cause: error,
      })
    }
  })()
  if (previousNotAfter.getTime() - now() > CA_RENEWAL_WINDOW_MS) {
    return certificateAuthority(stored, clock)
  }
  const renewed = await sealNewCa()
  deps.log({
    kind: 'gateway.ca.renewed',
    previousNotAfter: previousNotAfter.toISOString(),
    notAfter: certificateNotAfter(renewed.certPem).toISOString(),
  })
  return certificateAuthority(renewed, clock)
}

export class CaUnreadableError extends Error {}

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

export function gatewayStatus(input: {
  admission: AdmissionState
  agentPort: { host: string; port: number }
  caPem: string
}): GatewayStatus {
  const { admission } = input
  return {
    admission: admission.kind,
    detail:
      admission.kind === 'unreachable' || admission.kind === 'bind_failed'
        ? admission.reason.message
        : null,
    agentPort: input.agentPort,
    caFingerprint: new X509Certificate(input.caPem).fingerprint256,
  }
}

const os = implement(contract).$context<
  KurumiContext & {
    gateway: {
      status(): GatewayStatus
      egressLog: Pick<EgressLog, 'rows'>
      rules: Pick<RuleStore, 'list' | 'add' | 'remove'>
    }
  }
>()

export const router = os.router({
  status: os.status.handler(({ context }) => context.gateway.status()),
  log: os.log.handler(({ context, input }) => context.gateway.egressLog.rows(input)),
  rules: {
    list: os.rules.list.handler(({ context }) => context.gateway.rules.list()),
    add: os.rules.add.handler(({ context, input }) => context.gateway.rules.add(input)),
    remove: os.rules.remove.handler(({ context, input: [id] }) => context.gateway.rules.remove(id)),
  },
})
