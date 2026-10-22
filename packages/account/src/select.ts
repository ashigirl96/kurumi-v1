import type { CredentialSlot, SelectorShape, ServiceId, VendorId } from './catalog.ts'

export type AccountHandle = `${VendorId}/${string}` & { readonly __brand: 'AccountHandle' }

export function accountHandle(vendor: VendorId, label: string): AccountHandle {
  return `${vendor}/${label}` as AccountHandle
}

export type GrantedCandidate = {
  accountId: string
  handle: AccountHandle
  isDefault: boolean
  status: 'active' | 'needs_reauth'
}

export type Selector = { kind: 'handle'; handle: string } | { kind: 'none' }

export type Selection =
  | { ok: true; accountId: string; handle: AccountHandle; how: 'named' | 'only' | 'default' }
  | { ok: false; refusal: SelectionRefusal }

/**
 * Every refusal names the next step for the agent and none lists accounts outside the caller's group: an agent
 * learns about other groups' accounts only through a human-facing Connect Card.
 */
export type SelectionRefusal =
  | { code: 'account_not_connected'; service: ServiceId }
  | { code: 'account_ambiguous'; service: ServiceId; granted: AccountHandle[] }
  | { code: 'account_not_granted'; service: ServiceId; named: string; granted: AccountHandle[] }
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
 * `candidates` are the grants of the calling group for `service` and nothing else, so an ungranted account cannot
 * come out of here. A named handle wins, then the only grant, then the one default; never the first row.
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

  const defaults = candidates.filter(({ isDefault }) => isDefault)
  const [preferred] = defaults
  if (preferred && defaults.length === 1) return use(service, preferred, 'default')
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

/** `Bearer` and `token` carry the secret itself, `Basic` carries it as the password. */
function secretOfAuthorization(authorization: string | null): string | null {
  const [, scheme = '', value = ''] = /^(\w+)\s+(.+)$/.exec(authorization ?? '') ?? []
  switch (scheme.toLowerCase()) {
    case 'bearer':
    case 'token':
      return value
    case 'basic': {
      const userAndPassword = Buffer.from(value, 'base64').toString()
      const separator = userAndPassword.indexOf(':')
      return separator === -1 ? null : userAndPassword.slice(separator + 1)
    }
    default:
      return null
  }
}

function takeCredential(slot: CredentialSlot, headers: Headers, url: URL): string | null {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return secretOfAuthorization(takeHeader(headers, 'authorization'))
    case 'header':
      return takeHeader(headers, slot.header)
    case 'query':
      return takeQueryParam(url, slot.param)
  }
}

/**
 * Reads the handle the agent wrote where the real credential would go, and returns the request with that slot
 * emptied whether or not it held a selector. A value the shape does not recognize (the SDK's own placeholder)
 * is `none`.
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
