// @kurumi/rpc/contract — no domain (like monica's packages/ui). Runs anywhere.
// The meta vocabulary the one router is filtered and guarded by, and who is calling.
import { oc } from '@orpc/contract'

/**
 * Who is on the other end. Decided by the transport, never by input:
 * - host: the 0600 Unix socket (`kurumi` CLI on the host machine)
 * - human: Console session cookie, or a click on a card in Slack/Console (userId resolved by the channel)
 * - agent: a container, authenticated by its Session Token on the Agent Port
 */
export type Caller =
  | { kind: 'host' }
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; agentGroupId: string; sessionId: string }

export type AgentCaller = Extract<Caller, { kind: 'agent' }>

/**
 * What an agent may do with a procedure. Absent = agents are refused with FORBIDDEN by the guard
 * middleware before the handler runs (rpc/server.ts), so forgetting it fails closed.
 * - channel: runner plumbing (pull/post/heartbeat) and session tools; the handler scopes to caller.sessionId.
 * - own-group: allowed; an `agentGroupId` input other than the caller's is refused.
 * - scoped: nanoclaw's CLI Scope — refused under `disabled`, own group under `group` (another group is held
 *   for approval), anything under `global`.
 * - hold: always held for a human (self-mod).
 */
export type AgentAccess = 'channel' | 'own-group' | 'scoped' | 'hold'

export type Meta = {
  description?: string
  /** Shown as a `kurumi <domain> <verb>` command (host and in-container). */
  cli?: boolean
  agent?: AgentAccess
  /** Also exposed as an MCP tool in the runner, under this name. The tool list is derived from these. */
  tool?: { name: string; instructions: string }
  /** Humans other than the owner need an approval for this procedure; the value names the action on the card. */
  humanHold?: string
}

export const kc = oc.$meta<Meta>({})
