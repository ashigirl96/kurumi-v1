import type { CredentialSlot, SelectorShape, ServiceId, VendorId } from './catalog.ts'

/** `${vendor}/${label}`, e.g. `google/alice@work.example`. The only name an agent uses for an account. */
export type AccountHandle = `${VendorId}/${string}` & { readonly __brand: 'AccountHandle' }

export function accountHandle(vendor: VendorId, label: string): AccountHandle {
  return `${vendor}/${label}` as AccountHandle
}

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

function use(
  service: ServiceId,
  candidate: GrantedCandidate,
  how: 'named' | 'only' | 'default',
): Selection {
  if (candidate.status === 'needs_reauth') {
    return {
      ok: false,
      refusal: { code: 'account_needs_reauth', service, handle: candidate.handle },
    }
  }
  return { ok: true, accountId: candidate.accountId, handle: candidate.handle, how }
}

/**
 * Decides which granted account serves one request. A handle named in the slot wins; else the only grant; else the
 * group's Default Account for the service; else refuse with the list. Never "last match wins" or "first row wins".
 * The returned accountId is always one of `candidates`, which the caller has already filtered to the calling
 * group and the service, so an ungranted account cannot come out of here.
 */
export function selectAccount(
  service: ServiceId,
  candidates: readonly GrantedCandidate[],
  selector: Selector,
): Selection {
  const granted = () => candidates.map(({ handle }) => handle)

  if (selector.kind === 'handle') {
    const match = candidates.find(({ handle }) => handle === selector.handle)
    if (!match) {
      return {
        ok: false,
        refusal: {
          code: 'account_not_granted',
          service,
          named: selector.handle,
          granted: granted(),
        },
      }
    }
    return use(service, match, 'named')
  }

  const [first, ...others] = candidates
  if (!first) return { ok: false, refusal: { code: 'account_not_connected', service } }
  if (others.length === 0) return use(service, first, 'only')

  const preferred = candidates.find(({ isDefault }) => isDefault)
  if (preferred) return use(service, preferred, 'default')
  return { ok: false, refusal: { code: 'account_ambiguous', service, granted: granted() } }
}

const decodeQueryComponent = (value: string): string => {
  const spaced = value.replaceAll('+', ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

function takeQueryParam(url: URL, param: string): string | null {
  let found: string | null = null
  const kept: string[] = []
  for (const pair of url.search.slice(1).split('&')) {
    const separator = pair.indexOf('=')
    const name = decodeQueryComponent(separator === -1 ? pair : pair.slice(0, separator))
    if (name !== param) {
      kept.push(pair)
      continue
    }
    found ??= decodeQueryComponent(separator === -1 ? '' : pair.slice(separator + 1))
  }
  if (found !== null) url.search = kept.join('&')
  return found
}

function takeHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)
  headers.delete(name)
  return value?.trim() ?? null
}

function takeCredential(slot: CredentialSlot, headers: Headers, url: URL): string | null {
  switch (slot.kind) {
    case 'bearer':
      return /^Bearer +(.+)$/i.exec(takeHeader(headers, 'authorization') ?? '')?.[1] ?? null
    case 'header':
      return takeHeader(headers, slot.header)
    case 'basic': {
      const encoded = /^Basic +(.+)$/i.exec(takeHeader(headers, 'authorization') ?? '')?.[1]
      const userAndPassword = encoded ? Buffer.from(encoded, 'base64').toString() : ''
      const separator = userAndPassword.indexOf(':')
      return separator === -1 ? null : userAndPassword.slice(separator + 1)
    }
    case 'query':
      return takeQueryParam(url, slot.param)
  }
}

/**
 * Reads the selector from the slot the real credential would occupy, using the vendor's selector shape, and
 * returns the request with that slot cleared whether or not it held a selector. A slot value the shape does not
 * recognize (the SDK's own placeholder) is `none`. One way to name an account: there is no side header.
 */
export function readSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: Selector; stripped: { headers: Headers; url: URL } } {
  const headers = new Headers(req.headers)
  const url = new URL(req.url)
  const credential = takeCredential(slot, headers, url)
  const handle = credential === null ? null : shape.parse(credential)
  return {
    selector: handle === null ? { kind: 'none' } : { kind: 'handle', handle },
    stripped: { headers, url },
  }
}
