// @kurumi/account — internal, pure. The whole per-request account choice lives in this one function.
import type { CredentialSlot, SelectorShape, ServiceId, VendorId } from './catalog.ts'

/** `${vendor}/${label}`, e.g. `google/alice@work.example`. The only name an agent uses for an account. */
export type AccountHandle = `${VendorId}/${string}` & { readonly __brand: 'AccountHandle' }

/** One row of account_grant ⋈ account for the calling group and the service the request targets. */
export type GrantedCandidate = {
  accountId: string
  handle: AccountHandle
  isDefault: boolean
  status: 'active' | 'needs_reauth'
}

/** What the agent wrote into the slot, already parsed by `readSelector`. */
export type Selector = { kind: 'handle'; handle: string } | { kind: 'none' }

export type Selection =
  | { ok: true; accountId: string; handle: AccountHandle; how: 'named' | 'only' | 'default' }
  | { ok: false; refusal: SelectionRefusal }

/**
 * Every refusal names the next step for the agent. None of them lists accounts outside the caller's group:
 * an agent learns about other groups' accounts only through a human-facing Connect Card.
 */
export type SelectionRefusal =
  /** No grant of this service in the group. Next step: the `connect_account` tool. */
  | { code: 'account_not_connected'; service: ServiceId }
  /** Several grants, no selector, no default. Next step: name one of `granted` in the slot. */
  | { code: 'account_ambiguous'; service: ServiceId; granted: AccountHandle[] }
  /** The named handle is not granted to this group for this service. */
  | { code: 'account_not_granted'; service: ServiceId; named: string; granted: AccountHandle[] }
  /** Granted, but its refresh token is dead. Next step: `connect_account` again (same login updates the row). */
  | { code: 'account_needs_reauth'; service: ServiceId; handle: AccountHandle }

/**
 * Pure: decide which granted account serves one request.
 *
 * Order: a handle named in the slot wins; else the only grant; else the group's Default Account for the service;
 * else refuse with the list. Never "last match wins", never "first row wins".
 * Invariant: the returned accountId is always one of `candidates` — the caller passes only rows already filtered
 * by `account_grant.agent_group_id = principal.agentGroupId AND service = ?`, so an ungranted account cannot
 * come out of here.
 */
export function selectAccount(
  service: ServiceId,
  candidates: readonly GrantedCandidate[],
  selector: Selector,
): Selection {
  // TODO
  // if selector.kind === 'handle':
  //   c = candidates.find(c => c.handle === selector.handle)
  //   !c -> account_not_granted (granted = candidates.map(handle))
  //   c.status === 'needs_reauth' -> account_needs_reauth
  //   -> ok named
  // if candidates.length === 0 -> account_not_connected
  // if candidates.length === 1 -> ok only (or needs_reauth)
  // d = candidates.find(isDefault); d -> ok default (or needs_reauth)
  // -> account_ambiguous
  throw new Error('not implemented')
}

/**
 * Reads the selector from the slot the real credential would occupy, using the vendor's selector shape, and
 * returns the request with the slot cleared. A slot value the shape does not recognize (the SDK's own
 * placeholder) is `none`. One way to name an account: there is no side header.
 */
export function readSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: Selector; stripped: { headers: Headers; url: URL } } {
  throw new Error('not implemented')
}
