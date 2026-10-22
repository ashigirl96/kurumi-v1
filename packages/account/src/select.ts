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
 * learns about other groups' accounts only through a human-facing Connect Card. `named` is the text the agent wrote.
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

type Written = { scan: readonly string[]; around: string; credential: string }

function writtenInAuthorization(header: string): Written {
  const [, scheme = '', credential = ''] = /^(\w+\s+)(.+)$/.exec(header) ?? []
  switch (scheme.trim().toLowerCase()) {
    case 'bearer':
    case 'token':
      return { scan: [header], around: scheme, credential }
    case 'basic': {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(credential)) break
      const userAndPassword = Buffer.from(credential, 'base64').toString()
      const separator = userAndPassword.indexOf(':') + 1
      return {
        scan: [header, userAndPassword],
        around: userAndPassword.slice(0, separator),
        credential: userAndPassword.slice(separator),
      }
    }
  }
  return { scan: [header], around: header, credential: '' }
}

function takeHeader(headers: Headers, name: string): string[] {
  const value = headers.get(name)
  headers.delete(name)
  return value === null ? [] : [value]
}

const takeAuthorization = (headers: Headers): Written[] =>
  takeHeader(headers, 'authorization').map(writtenInAuthorization)

/** An SDK sends its auth token as Authorization, so a service whose slot is another header still sees a selector there. */
function takeNamingAuthorization(headers: Headers): Written[] {
  const value = headers.get('authorization')
  return value !== null && mentionsKurumi(value) ? takeAuthorization(headers) : []
}

const alone = (credential: string): Written => ({ scan: [credential], around: '', credential })

function takeWritten(slot: CredentialSlot, headers: Headers, url: URL): Written[] {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return takeAuthorization(headers)
    case 'header':
      return [...takeHeader(headers, slot.header).map(alone), ...takeNamingAuthorization(headers)]
    case 'query':
      return takeQueryParam(url, slot.param).map(alone)
  }
}

const escapesDecoded = (text: string): string =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )

/** The shortest base64 that holds the six bytes of the word is eight characters. */
const base64Views = (text: string): string[] =>
  [text.replaceAll(/\s+/g, ''), ...text.split(/[^A-Za-z0-9+/=_-]+/)]
    .filter((token) => token.length >= 8)
    .map((token) => Buffer.from(token, 'base64').toString())

/**
 * Real third-party credentials do not hold the word, so a value that does is the agent naming an account. The word
 * is looked for as written, with percent escapes decoded, and inside base64 tokens of the value past its scheme.
 */
function mentionsKurumi(text: string): boolean {
  const escaped = text.includes('%') ? [escapesDecoded(text), decodeQueryComponent(text)] : []
  const body = text.replace(/^\w+\s+/, '')
  return (
    [text, ...escaped].some((view) => /kurumi/iu.test(view)) ||
    [body, ...escaped].some((view) => base64Views(view).some((decoded) => /kurumi/iu.test(decoded)))
  )
}

/** Once the word appears the result is never `none`, which would fall back to the default account. */
function selectorIn(
  values: readonly Written[],
  parse: (credential: string) => string | null,
): Selector {
  const naming = values.filter(({ scan }) => scan.some(mentionsKurumi))
  const [only] = values
  if (!only || naming.length === 0) return { kind: 'none' }
  const handle = values.length === 1 && !mentionsKurumi(only.around) ? parse(only.credential) : null
  return handle !== null && !mentionsKurumi(handle)
    ? { kind: 'handle', handle }
    : { kind: 'unreadable', written: naming.map((v) => v.around + v.credential).join(' | ') }
}

function parseAsWrittenThenDecoded(shape: SelectorShape, value: string): string | null {
  const decoded = decodeQueryComponent(value)
  const [first, second] = /%2f/i.test(value) ? [decoded, value] : [value, decoded]
  return shape.parse(first) ?? shape.parse(second)
}

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
