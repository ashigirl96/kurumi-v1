// apps/host — env + $KURUMI_HOME/config.json → typed config, validated once at start (boundary).
import type { ApprovalCardPolicy } from '@kurumi/approval/server'

export type HostConfig = {
  home: string
  templatesDir: string
  dockerPath: string
  /** Stable port: containers keep it in their env across host restarts (never port 0). */
  agentPort: { host: string; port: number }
  containerHostName: string
  egressLockdown: { dockerNetwork: string } | null
  web: { host: string; port: number }
  publicBaseUrl: string
  approvalCardPolicy: ApprovalCardPolicy
}

export function loadConfig(env: Record<string, string | undefined>): HostConfig {
  throw new Error('not implemented')
}
