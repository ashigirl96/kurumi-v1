// @kurumi/account — internal. Connection Request: the in-chat connect flow's single owner of state.
import type { Card } from '@kurumi/chat/contract'

import type { ServiceId, VendorId } from './catalog.ts'
import type { AccountHandle } from './select.ts'

export type ConnectionRequestId = `cr-${string}` & { readonly __brand: 'ConnectionRequestId' }

type Base = {
  id: ConnectionRequestId
  agentGroupId: string
  vendor: VendorId
  services: readonly ServiceId[]
  /** operator = started from Console/CLI: completion grants but resumes no session and edits no card. */
  origin: { kind: 'session'; sessionId: string; cardMessageId: string } | { kind: 'operator' }
  requestedBy: string
  expiresAt: Date
}

/**
 * State machine. Every transition is in `server.ts`, in one sync transaction that re-reads the row:
 *
 *   open ──start (via a connect link)──▶ authorizing ──callback ok──▶ completed
 *    │  ◀────────── callback failed (lastError) ────┘                  ▲
 *    ├──useExisting (admin click)────────────────────────────────────┘
 *    ├──sweep past expiresAt──▶ expired
 *    └──cancel──▶ cancelled
 *
 * The Connect button is an action: pressing it mints a connect_link for the presser if they are an approver of
 * the group (Slack: ephemeral message with the link; Console: navigation). Pressing twice mints two links; both
 * lead to the same authorize URL, because start on `authorizing` reuses the stored state + PKCE verifier.
 * A used or 5-minute-old link shows "press the button again". Callback on `completed` renders the same success
 * page (reload / back button). Host restart: request, verifier and links are all in SQLite.
 */
export type ConnectionRequest =
  | (Base & { state: 'open'; lastError: string | null })
  | (Base & { state: 'authorizing'; oauthState: string })
  | (Base & { state: 'completed'; handle: AccountHandle; grantedServices: readonly ServiceId[] })
  | (Base & { state: 'expired' | 'cancelled' })

/** Row → domain. Throws on a row whose columns contradict its state (corruption, not input). */
export function parseConnectionRequest(row: unknown): ConnectionRequest {
  throw new Error('not implemented')
}

/**
 * The Connect Card is built by the host from the request row and the account table, never from agent text,
 * and it carries no URL.
 * - open/authorizing: action button "Connect a <Vendor> account" (`{ owner: 'account', action: 'mint-link', id }`), plus one action button
 *   per already-connected account of this vendor covering the services but not granted to the group
 *   ("Use alice@…", `{ owner: 'account', action: 'use-existing', id, value: accountId }`). Both are honoured only for approvers of the group.
 * - completed: "✅ <handle> connected to <group> for <services>"; expired: "⏱ expired — ask again".
 */
export function connectCard(
  request: ConnectionRequest,
  existing: readonly { accountId: string; label: string }[],
): Card {
  throw new Error('not implemented')
}

/** Text the session receives on completion; it wakes the agent so it carries on without the user re-asking. */
export function completionNotice(request: ConnectionRequest & { state: 'completed' }): string {
  // TODO `<system>Account ${handle} is now connected for ${services}. Continue the task that needed it.</system>`
  throw new Error('not implemented')
}
