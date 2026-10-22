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
  | { kind: 'unreadable'; written: string }
  | { kind: 'none' }

export type Selection =
  | { ok: true; accountId: string; handle: AccountHandle; how: 'named' | 'only' | 'default' }
  | { ok: false; refusal: SelectionRefusal }

/**
 * Every refusal names the next step for the agent and none lists accounts outside the caller's group: an agent
 * learns about other groups' accounts only through a human-facing Connect Card. For `account_not_granted`, `named`
 * is the handle the agent wrote, or the text it wrote where no single selector could be read from it.
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
  const notGranted = (named: string): Selection => ({
    ok: false,
    refusal: { code: 'account_not_granted', service, named, granted: granted() },
  })

  if (selector.kind === 'unreadable') return notGranted(selector.written)

  if (selector.kind === 'handle') {
    const match = candidates.find(({ handle }) => handle === selector.handle)
    return match ? use(service, match, 'named') : notGranted(selector.handle)
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

/** What a slot value holds beside the one place its credential goes. */
type Written = { beside: string; credential: string }

function writtenInAuthorization(header: string): Written {
  const [, scheme = '', credential = ''] = /^(\w+\s+)(.+)$/.exec(header) ?? []
  switch (scheme.trim().toLowerCase()) {
    case 'bearer':
    case 'token':
      return { beside: scheme, credential }
    case 'basic': {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(credential)) break
      const userAndPassword = Buffer.from(credential, 'base64').toString()
      const separator = userAndPassword.indexOf(':') + 1
      return {
        beside: userAndPassword.slice(0, separator),
        credential: userAndPassword.slice(separator),
      }
    }
  }
  return { beside: header, credential: '' }
}

function takeHeader(headers: Headers, name: string): string[] {
  const value = headers.get(name)
  headers.delete(name)
  return value === null ? [] : [value]
}

const alone = (credential: string): Written => ({ beside: '', credential })

function takeWritten(slot: CredentialSlot, headers: Headers, url: URL): Written[] {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return takeHeader(headers, 'authorization').map(writtenInAuthorization)
    case 'header':
      return takeHeader(headers, slot.header).map(alone)
    case 'query':
      return takeQueryParam(url, slot.param).map(alone)
  }
}

/** Real third-party credentials do not hold the word, so a value that does is the agent naming an account. */
function mentionsKurumi(text: string): boolean {
  const base64Tokens = text.split(/[\s,]+/).map((token) => Buffer.from(token, 'base64').toString())
  return [text, decodeQueryComponent(text), ...base64Tokens].some((view) => /kurumi/i.test(view))
}

/**
 * Every value in the slot gets one of two readings. With no value mentioning kurumi there is no selector and the
 * result is `none`, which is how the SDK's own placeholder passes. Once any value mentions it the request names an
 * account, and it is read only when the slot holds one value that is one selector where the credential goes and
 * names a label that does not mention the word. Everything else is refused, never `none` and never another account.
 */
function selectorIn(
  values: readonly Written[],
  parse: (credential: string) => string | null,
): Selector {
  const texts = values.map(({ beside, credential }) => beside + credential)
  if (!texts.some(mentionsKurumi)) return { kind: 'none' }
  const [only, ...more] = values
  const handle =
    only && more.length === 0 && !mentionsKurumi(only.beside) ? parse(only.credential) : null
  return handle !== null && !mentionsKurumi(handle)
    ? { kind: 'handle', handle }
    : { kind: 'unreadable', written: texts.join(' | ') }
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

/**
 * Reads the handle the agent wrote where the real credential would go, and returns the request with that slot
 * emptied whether or not it held a selector.
 */
export function readSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: Selector; stripped: { headers: Headers; url: URL } } {
  const headers = new Headers(req.headers)
  const url = new URL(req.url)
  const parse = (credential: string) =>
    slot.kind === 'query' ? parseAsWrittenThenDecoded(shape, credential) : shape.parse(credential)
  return {
    selector: selectorIn(takeWritten(slot, headers, url), parse),
    stripped: { headers, url },
  }
}
