// @kurumi/gateway — internal. One HTTP request inside a MITM'd tunnel, start to finish. This is the forward
// engine: everything it needs comes in through `ForwardDeps`, so it could later move behind an IPC boundary
// (a separate proxy process) without changing its callers.
// Order is load-bearing: select the account first, then evaluate rules against that account, then hold/forward.
// A key never "hides" an OAuth account (OneCLI mitm.rs:303): there is one pipeline per service.
import type { AccountLedger, SelectionRefusal, ServiceId } from '@kurumi/account/server'
import type { AgentPrincipal } from '@kurumi/session/contract'

export type RuleEffect =
  | { kind: 'allow' }
  | { kind: 'block'; ruleId: string }
  | { kind: 'approve'; ruleId: string }
  | { kind: 'rate_limit'; ruleId: string; perMinute: number }

export type CompiledRule = {
  id: string
  agentGroupId: string | null
  target: { accountId: string } | { service: ServiceId } | { host: string }
  method: string | null
  path: string | null // glob
  effect: RuleEffect
}

/**
 * Pure. First match by priority (the array is pre-sorted). No match = allow.
 * Account-aware: an `{ accountId }` target matches only requests injected with that account.
 */
export function evaluate(
  rules: readonly CompiledRule[],
  req: { agentGroupId: string; accountId: string | null; service: ServiceId | null; host: string; method: string; path: string },
): RuleEffect {
  throw new Error('not implemented')
}

/** Every non-2xx the gateway itself writes. JSON body; `x-kurumi-gateway: <code>` header. */
export type GatewayRefusal =
  | SelectionRefusal
  | { code: 'blocked_by_rule'; ruleId: string }
  | { code: 'rate_limited'; retryAfterS: number }
  | { code: 'approval_denied'; approvalId: string; reason: string | null }
  /** The hold ended before a decision. If a human approves later, the session is told to resend it unchanged. */
  | { code: 'approval_pending'; approvalId: string }

/** Exhaustive over the refusal codes: a new refusal without a status does not compile. */
export const REFUSAL_STATUS: Record<GatewayRefusal['code'], number> = {
  account_not_connected: 404,
  account_ambiguous: 409,
  account_not_granted: 403,
  account_needs_reauth: 401,
  blocked_by_rule: 403,
  rate_limited: 429,
  approval_denied: 403,
  approval_pending: 403,
}

/**
 * Body the agent reads. Each code carries the next step in words the tool instructions also use, e.g.
 * account_not_connected → "call the connect_account tool with services=[<service>]". No URLs: the agent never
 * relays a link (cards are host-built, links are minted per approver).
 */
export function refusalResponse(refusal: GatewayRefusal): Response {
  return Response.json(
    { error: refusal.code, ...refusal, next: nextStep(refusal) },
    { status: REFUSAL_STATUS[refusal.code], headers: { 'x-kurumi-gateway': refusal.code } },
  )
}

function nextStep(refusal: GatewayRefusal): string {
  throw new Error('not implemented')
}

export type ForwardDeps = {
  accountLedger: Pick<AccountLedger, 'credentialFor'>
  rules: () => readonly CompiledRule[] // in-memory, rebuilt on rule change events
  hold: (input: HoldInput) => Promise<HoldOutcome>
  consumeAllowance: (sessionId: string, fingerprint: Uint8Array) => boolean
  log: (entry: LogEntry) => void // buffered; flushed in one transaction per second
  fetchUpstream: (req: Request) => Promise<Response>
}

export type HoldInput = {
  principal: AgentPrincipal
  accountId: string
  service: ServiceId
  method: string
  host: string
  path: string
  /** First 16 KiB, for the service summarizer. */
  bodyPreview: Uint8Array
  fingerprint: Uint8Array
}

export type HoldOutcome =
  | { decision: 'approve'; approvalId: string }
  | { decision: 'deny'; approvalId: string; reason: string | null }
  | { decision: 'pending'; approvalId: string } // hold timed out or agent hung up; decision continues async

export type LogEntry = {
  principal: AgentPrincipal
  accountId: string | null
  service: ServiceId | null
  method: string
  host: string
  path: string
  decision: 'injected' | 'blocked' | 'approved' | 'denied' | 'timed_out' | 'rate_limited' | 'refused'
  refusal?: GatewayRefusal['code']
  status?: number
  durationMs?: number
}

/**
 * target = serviceFor(host, path)            (null → forward untouched; MITM'd only because the host is shared)
 * decision = accountLedger.credentialFor(principal, {vendor, service, headers, url})
 *   refused → log + refusalResponse(selection refusal)
 * effect = evaluate(rules, {…, accountId: decision.injection.accountId, service})
 *   block → 403; rate_limit exceeded → 429
 *   approve → fingerprint = sha256(method, host, path, accountId, full body (≤10 MiB buffered, else 413))
 *             consumeAllowance(session, fingerprint) ? forward : hold(...)
 *               approve → forward;  deny → approval_denied;  pending → approval_pending
 * forward: injection.apply(stripped) → fetchUpstream → add `x-kurumi-account: <handle>` → log injected
 */
export async function forward(principal: AgentPrincipal, req: Request, deps: ForwardDeps): Promise<Response> {
  throw new Error('not implemented')
}
