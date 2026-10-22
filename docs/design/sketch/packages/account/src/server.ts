// @kurumi/account/server
// Imports below session only through schema (FK) and contract (types). Writes into a session arrive as
// functions in `deps.sessions`, which the host wires from the session ledger (monica ADR-0013).
import type { AccessLedger } from '@kurumi/access/server'
import type { AgentLedger } from '@kurumi/agent/server'
import type { Card, CardAction, CardActionReply } from '@kurumi/chat/contract'
import type { SystemJob } from '@kurumi/job/server'
import type { Caller } from '@kurumi/rpc/contract'
import type { Db, KurumiContext, Tx } from '@kurumi/rpc/server'
import type { AgentPrincipal } from '@kurumi/session/contract'
import { implement } from '@orpc/server'

import type { ApprovalSummary, ServiceId, VendorId } from './catalog.ts'
import { contract } from './contract.ts'
import type { AccountHandle, SelectionRefusal } from './select.ts'

export { migrations } from '../migrations/index.ts'
export { interceptedHosts, serviceFor } from './catalog.ts'
export type { AccountHandle, SelectionRefusal, ServiceId, VendorId }

/**
 * Decrypted credential bound to one request. Opaque: the secret is closed over, there is no field to read, and it
 * is not serializable (toJSON throws). Only the gateway's forwarder calls `apply`.
 */
export interface Injection {
  readonly handle: AccountHandle
  readonly accountId: string
  /** Writes the real credential into the service's slot of an outgoing request. */
  apply(req: { headers: Headers; url: URL }): void
}

/** The request facts the choice depends on. Built by the gateway from the decrypted HTTP request. */
export type EgressTarget = {
  vendor: VendorId
  service: ServiceId
  headers: Headers
  url: URL
}

export type CredentialDecision =
  | { ok: true; injection: Injection; stripped: { headers: Headers; url: URL } }
  | { ok: false; refusal: SelectionRefusal }

export type OAuthPage =
  | { kind: 'redirect'; url: string }
  | { kind: 'done'; handle: AccountHandle; groupName: string; services: readonly ServiceId[] }
  | { kind: 'link_used' | 'link_expired' | 'expired' | 'cancelled' | 'unknown' }
  | { kind: 'failed'; message: string }

/** Session-side writes account needs. Wired by the host from SessionLedger; account never imports session/server. */
export type SessionCards = {
  /** Posts a host-built card into the session's Bound Chat. Returns the outbound message id. */
  postCard(tx: Tx, sessionId: string, card: Card): string
  /** Re-renders an already delivered card in place. */
  replaceCard(tx: Tx, outboundMessageId: string, card: Card): void
  /** Triggered system message into the session: wakes or spawns the agent after commit. */
  notifySession(tx: Tx, sessionId: string, text: string): void
}

export type AccountLedger = {
  start(): void
  stop(): void
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }

  /**
   * THE choke point: the only exported way to obtain credential material.
   * Reads account_grant ⋈ account for `principal.agentGroupId` and `target.service` (live, indexed, no cache),
   * reads the selector with the vendor's shape, runs `selectAccount`, then decrypts — refreshing first if the
   * access token is expired. Refresh is single-flight per account (one in-process Map<accountId, Promise>),
   * network outside any transaction, write-back in a sync transaction that re-reads the row (refresh-token
   * rotation safe even when several groups share the account). invalid_grant flips the account to needs_reauth.
   */
  credentialFor(principal: AgentPrincipal, target: EgressTarget): Promise<CredentialDecision>

  /** Placeholder env for the services this group holds (e.g. ANTHROPIC_API_KEY=<selector>). No secrets. */
  containerEnv(agentGroupId: string): Record<string, string>

  /** Web listener: GET /connect/:token. Consumes the one-time link; idempotent per request (authorizing → same URL). */
  startConnection(token: string): OAuthPage
  /** Web listener: GET /oauth/callback. Exchange is outside the transaction; completion re-reads the row. */
  finishConnection(query: { state?: string; code?: string; error?: string }): Promise<OAuthPage>

  /**
   * Card clicks owned by account. `mint-link`: approver of the group → one-time 5-minute link, returned privately
   * (Slack ephemeral / Console navigation); anyone else → "only approvers of <group> can connect accounts".
   * `use-existing`: approver → grant without OAuth, same completion transaction as the callback.
   */
  onCardAction(action: CardAction, clicker: Caller): Promise<CardActionReply>
}

/** Approval-card summary for one held request (service spec's summarizer, generic fallback). */
export function summarizeRequest(
  service: ServiceId,
  req: { method: string; path: string; bodyPreview: Uint8Array },
): ApprovalSummary {
  throw new Error('not implemented')
}

/** Cross-domain read for the gateway's log and approval cards. */
export function handleOf(db: Db, accountId: string): AccountHandle | null {
  throw new Error('not implemented')
}

export function createAccountLedger(deps: {
  db: Db
  /** 32-byte AES key read from $KURUMI_HOME/vault.key (0600). Same backup unit as kurumi.db. */
  vaultKey: Uint8Array
  /** Browser-reachable base for /connect and /oauth/callback (loopback: OAuth happens only at the Mac). */
  publicBaseUrl: string
  agentLedger: AgentLedger
  accessLedger: AccessLedger
  sessions: SessionCards
  fetch?: typeof fetch
}): AccountLedger {
  // TODO internals: { db, vault, refreshing: Map<accountId, Promise<void>> } in a WeakMap, monica-style.
  //
  // start():
  //   agentLedger.events.subscribe(created) → queueMicrotask(applyAutoGrants)
  //   applyAutoGrants() once now: for every (agentGroup, autoGrant account, service ∈ account.services)
  //   insert account_grant on conflict do nothing (re-applying the invariant covers events missed while stopped).
  //
  // grant(tx, {group, account, service, by})  — the one writer of account_grant:
  //   service ∉ account.services → BAD_REQUEST "google/alice@… does not cover google-calendar; reconnect with it"
  //   insert (vendor copied from the account; FK + CHECK reject a mismatch) on conflict do nothing
  //
  // connect (agent caller):
  //   vendor = vendorOf(services[0]); all services of one vendor else BAD_REQUEST
  //   db.transaction(tx => {
  //     live = select connection_request where (group, vendor, sessionId) and state in (open, authorizing)
  //     if live → return { kind:'card_posted', requestId: live.id }          // agent asked twice
  //     insert open row (expiresAt = now + 30 min)
  //     cardMessageId = deps.sessions.postCard(tx, sessionId, connectCard(row, existingUngranted))
  //     update row.cardMessageId
  //   })
  // connect (host/human caller): insert open row with origin operator, mint a link for the caller, return it.
  //
  // onCardAction('mint-link', clicker):
  //   accessLedger.isApprover(clicker, group) else reply ephemeral refusal
  //   tx: request live? → insert connect_link{sha256(token), mintedFor, expiresAt: now + 5 min}
  //   reply { kind: 'private-link', url: `${publicBaseUrl}/connect/${token}`, label: 'Open <Vendor> consent' }
  //
  // startConnection(token):
  //   tx: link = by sha256(token); none → unknown; usedAt → link_used; past expiresAt → link_expired
  //       mark link used
  //       request open → mint oauthState + PKCE verifier (encrypted), state=authorizing
  //       request authorizing → reuse stored state + verifier (two links, one URL)
  //       request completed/expired/cancelled → that page
  //   build authorize URL with scopesFor(request.services)
  //
  // finishConnection({state, code}):
  //   row = select by oauthState (no tx); not found → unknown; completed → done (idempotent)
  //   tokens = await exchange(code, verifier)                              // network, outside tx
  //   {subject, label, grantedScopes} = await oauth.identify(tokens)       // network, outside tx
  //   tx:
  //     row = re-read by id; state ≠ authorizing → discard tokens, render row's current page
  //     acc = upsert account on (vendor, subject): material, label, status=active,
  //           services = servicesCovered(vendor, grantedScopes) ∪ previous services
  //     for s in row.services ∩ acc.services: grant(tx, …)
  //     row.services − acc.services ≠ ∅ → the user unticked a scope (granular consent); the completion notice
  //       names the services that were not granted instead of claiming success for all of them
  //     row → completed(accountId), clear oauthState + verifier
  //     origin session: deps.sessions.replaceCard(tx, cardMessageId, connectCard(completed))
  //                     deps.sessions.notifySession(tx, sessionId, completionNotice(row))   // wakes the agent
  //   exchange error: tx: row back to open with lastError; card shows "failed — press Connect again"
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { accountLedger: AccountLedger }>()

const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  mine: os.mine.handler(notImplemented),
  connect: os.connect.handler(notImplemented),
  list: os.list.handler(notImplemented),
  grant: os.grant.handler(notImplemented),
  revoke: os.revoke.handler(notImplemented),
  setDefault: os.setDefault.handler(notImplemented),
  addKey: os.addKey.handler(notImplemented),
  remove: os.remove.handler(notImplemented),
  setClient: os.setClient.handler(notImplemented),
  requests: os.requests.handler(notImplemented),
  cancel: os.cancel.handler(notImplemented),
})

/** Expires live Connection Requests past expiresAt and edits their cards; prunes used/expired links. Idempotent. */
export function systemJobs(accountLedger: AccountLedger): SystemJob[] {
  return [{ name: 'account.expire-connection-requests', every: 60_000, run: async () => notImplemented() }]
}
