// @kurumi/gateway/server
// Owns the Agent Port: the single listener a container can reach. CONNECT = egress proxy (this package);
// any other method = the oRPC handler for agent callers (passed in by the host). Both authenticate the
// same Session Token through session.authenticate, so there is one identity and one door.
import type { AccountLedger } from '@kurumi/account/server'
import type { ApprovalDecisionHandler, ApprovalLedger } from '@kurumi/approval/server'
import type { SystemJob } from '@kurumi/job/server'
import type { AgentCaller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import type { Admission, ContainerDriver, ContainerEgress, SessionLedger } from '@kurumi/session/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'

export type GatewayLedger = {
  /**
   * Loads/creates the CA, compiles rules, binds the Agent Port (admission `binding`), then runs the probe
   * container (admission `probing`): a throwaway container on the agent network must fetch
   * `http://<containerHostName>:<port>/probe/<nonce>` and read the nonce back. Only then does admission open.
   * Bind failure or probe failure keeps admission closed (`bind_failed` / `unreachable`), tells the owner once,
   * and the gateway sweep retries with backoff (1 s → 60 s). Fail closed, never terminal.
   */
  start(): Promise<void>
  /** Closes the port: every in-flight hold resolves `pending` (its approval row stays live → allowance on approve). */
  stop(): Promise<void>
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }

  /** For session's spawn path (passed as deps.egress by the host). */
  admission(): Admission
  contribution(input: { agentGroupId: string; sessionToken: string }): ContainerEgress

  /** Registered with the approval domain under kind 'gateway.request'. */
  onApprovalDecision: ApprovalDecisionHandler
}

export function createGatewayLedger(deps: {
  db: Db
  home: string
  vaultKey: Uint8Array
  /** macOS Docker Desktop: 127.0.0.1 (reported reachable as host.docker.internal; the probe re-checks every boot). */
  bind: { host: string; port: number }
  containerHostName: string // 'host.docker.internal'
  egressLockdown: { dockerNetwork: string } | null
  accountLedger: AccountLedger
  sessionLedger: Pick<SessionLedger, 'authenticate' | 'notify' | 'originOf'>
  approvalLedger: Pick<ApprovalLedger, 'request'>
  /** From session's container driver (host wires it). */
  probe: ContainerDriver['probe']
  /** oRPC fetch handler for agent callers; the gateway attaches `caller` after authenticating. */
  agentRpc: (req: Request, caller: AgentCaller) => Promise<Response>
  /** Hold length before answering `approval_pending`. */
  holdMs?: number // default 180_000
}): GatewayLedger {
  // TODO internals: { server: node:http Server, holds: Map<approvalId, resolve>, rules: CompiledRule[],
  //                   leafCache: Map<host, SecureContext> (24 h, keyed by the CONNECT host), logBuffer: LogEntry[],
  //                   rate: Map<ruleId:group, window>, admission: Admission, probeNonce }
  //
  // Agent Port (node:http server; Bun 1.4.3 handles 'connect' + TLSSocket({ isServer: true }) — sonnet's spike):
  //   'request' GET /probe/<nonce> → nonce (unauthenticated; reveals nothing)
  //   'request' other → bearer = Authorization; principal = sessionLedger.authenticate(bearer) ?? 401
  //              → agentRpc(req, {kind:'agent', agentGroupId, sessionId})
  //   Bun 1.4.3 ignores SNICallback on a server TLSSocket (spike), so the leaf is chosen from the CONNECT host
  //   before the handshake starts.
  //   'connect' → token = Proxy-Authorization basic password; principal = authenticate(token) ?? 407 (no anonymous tunnel)
  //              host ∉ mitmHosts → host-level rule check (block → 403) → raw tunnel, no inspection
  //              host ∈ mitmHosts → TLSSocket({ isServer, secureContext: leaf for CONNECT host }) → each request →
  //                                 forward(principal, req, …)
  //   mitmHosts = interceptedHosts() ∪ hosts named by rules that need method/path
  //   Token revocation is immediate for new CONNECTs; an open tunnel re-authenticates per inner request.
  //
  // hold(input):
  //   tx: approvalLedger.request(tx, { kind:'gateway.request', origin: sessionLedger.originOf(sessionId),
  //         title, body: [handle + service, `${method} ${host}${path}`, summarizeRequest(service, …), origin.chatName],
  //         payload: { accountId, service, method, host, path, fingerprint } })
  //   await min(holdMs, decision) → approve/deny, or 'pending' on timeout / client disconnect.
  //
  // onApprovalDecision(approval, decision):
  //   holds.get(id) → resolve it (the agent's original request completes or gets 403)
  //   else (hold gone) and approve → tx: insert egress_allowance(expires +10 min);
  //         sessionLedger.notify(tx, sessionId,
  //           "Your <METHOD host/path> as <handle> was approved. Resend exactly the same request (same body) within 10 minutes.")
  //   else and reject → sessionLedger.notify(tx, sessionId, "… was rejected: <reason>")
  //
  // contribution({agentGroupId, sessionToken}):
  //   env: HTTPS_PROXY/HTTP_PROXY (both cases) = http://s:<token>@<containerHostName>:<port>
  //        NO_PROXY=<containerHostName>, KURUMI_URL=http://<containerHostName>:<port>, KURUMI_TOKEN=<token>
  //        NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / DENO_CERT → mounted CA bundle
  //        ...accountLedger.containerEnv(agentGroupId)   (selectors only)
  //   mounts: $KURUMI_HOME/ca/combined-<sha>.pem → /etc/kurumi/ca.pem (ro), content-addressed
  //   network: egressLockdown ? lockdown : default
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { gatewayLedger: GatewayLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  status: os.status.handler(notImplemented),
  rules: {
    list: os.rules.list.handler(notImplemented),
    add: os.rules.add.handler(notImplemented),
    remove: os.rules.remove.handler(notImplemented),
  },
  log: os.log.handler(notImplemented),
})

/**
 * 'gateway.admission' (10 s, backoff inside): rebind / re-probe while admission is closed.
 * 'gateway.prune' (1 h): egress_log > 30 d, expired allowances. Log flush itself is in-process (1 s).
 */
export function systemJobs(gatewayLedger: GatewayLedger): SystemJob[] {
  return [
    { name: 'gateway.admission', every: 10_000, run: async () => notImplemented() },
    { name: 'gateway.prune', every: 3_600_000, run: async () => notImplemented() },
  ]
}
