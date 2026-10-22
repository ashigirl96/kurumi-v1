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

export type Selector =
  | { kind: 'handle'; handle: string }
  | { kind: 'conflict'; handles: readonly [string, string, ...string[]] }
  | { kind: 'none' }

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

  if (selector.kind === 'conflict') {
    return {
      ok: false,
      refusal: {
        code: 'account_not_granted',
        service,
        named: selector.handles.join(' | '),
        granted: granted(),
      },
    }
  }

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

function takeQueryParam(url: URL, param: string): string[] {
  const values: string[] = []
  const kept: string[] = []
  for (const pair of url.search.slice(1).split('&')) {
    const separator = pair.indexOf('=')
    const name = decodeQueryComponent(separator === -1 ? pair : pair.slice(0, separator))
    if (name === param) values.push(separator === -1 ? '' : pair.slice(separator + 1))
    else kept.push(pair)
  }
  if (values.length > 0) url.search = kept.join('&')
  return values
}

/** A header sent twice reaches us as one value joined with commas, which no selector contains. */
function takeHeader(headers: Headers, name: string): string[] {
  const value = headers.get(name)
  headers.delete(name)
  return value === null ? [] : value.split(',').map((part) => part.trim())
}

/** `Bearer` and `token` carry the secret itself, `Basic` carries it as the password. */
function secretOfAuthorization(authorization: string): string | null {
  const [, scheme = '', value = ''] = /^(\w+)\s+(.+)$/.exec(authorization) ?? []
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

function takeCredentials(slot: CredentialSlot, headers: Headers, url: URL): string[] {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return takeHeader(headers, 'authorization').flatMap((authorization) => {
        const secret = secretOfAuthorization(authorization)
        return secret === null ? [] : [secret]
      })
    case 'header':
      return takeHeader(headers, slot.header)
    case 'query':
      return takeQueryParam(url, slot.param)
  }
}

/**
 * Every handle holds a `/`, which a component encoder writes as `%2F` and `format` never does. A value with `%2F`
 * was encoded again and is decoded first. Any other value is the shape's own text, read as written.
 */
function parseAsWrittenThenDecoded(shape: SelectorShape, value: string): string | null {
  const decoded = decodeQueryComponent(value)
  const [first, second] = /%2f/i.test(value) ? [decoded, value] : [value, decoded]
  return shape.parse(first) ?? shape.parse(second)
}

function selectorOf(handles: readonly string[]): Selector {
  const [first, second, ...rest] = [...new Set(handles)]
  if (first === undefined) return { kind: 'none' }
  if (second === undefined) return { kind: 'handle', handle: first }
  return { kind: 'conflict', handles: [first, second, ...rest] }
}

/**
 * Reads the handle the agent wrote where the real credential would go, and returns the request with that slot
 * emptied whether or not it held a selector. A value the shape does not recognize (the SDK's own placeholder)
 * is `none`, unless another value in the same slot carries a selector.
 */
export function readSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: Selector; stripped: { headers: Headers; url: URL } } {
  const headers = new Headers(req.headers)
  const url = new URL(req.url)
  const parse = (value: string) =>
    slot.kind === 'query' ? parseAsWrittenThenDecoded(shape, value) : shape.parse(value)
  const handles = takeCredentials(slot, headers, url).flatMap((value) => parse(value) ?? [])
  return { selector: selectorOf(handles), stripped: { headers, url } }
}
