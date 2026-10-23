import {
  catalog,
  selectorShapeOf,
  type CredentialSlot,
  type SelectorShape,
  type ServiceId,
  type VendorId,
} from './catalog.ts'

export type AccountHandle = `${VendorId}/${string}` & { readonly __brand: 'AccountHandle' }

export function accountHandle(vendor: VendorId, label: string): AccountHandle {
  return `${vendor}/${label}` as AccountHandle
}

const isVendorId = (value: string): value is VendorId => Object.hasOwn(catalog, value)

export function parseAccountHandle(handle: string): { vendor: VendorId; label: string } | null {
  const slash = handle.indexOf('/')
  if (slash === -1) return null
  const vendor = handle.slice(0, slash)
  const label = handle.slice(slash + 1)
  return isVendorId(vendor) && label !== '' ? { vendor, label } : null
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
 * come out of here.
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

/**
 * The selector a container holds when it should get whatever account its group chooses at request time. It is the
 * vendor id alone, which no Account Handle can be because a handle always has a non-empty `/<label>`.
 */
export function groupSelector(vendor: VendorId): string {
  return selectorShapeOf(vendor).format(vendor)
}

export function unnamedIfGroupSelector(vendor: VendorId, selector: Selector): Selector {
  return selector.kind === 'handle' && selector.handle === vendor ? { kind: 'none' } : selector
}

const decodedOnce = (text: string): string | null => {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/** `+` is a space in a query value, as `URLSearchParams` reads it. */
const decodedQueryValue = (value: string): string | null => decodedOnce(value.replaceAll('+', ' '))

const word = /kurumi/i
const escapedLetterOfWord = /%(?:6b|4b|75|55|72|52|6d|4d|69|49)/i

const mentionsIn =
  (decode: (text: string) => string | null) =>
  (text: string): boolean =>
    word.test(text) || (escapedLetterOfWord.test(text) && word.test(decode(text) ?? ''))
const mentions = mentionsIn(decodedOnce)
const mentionsInQuery = mentionsIn(decodedQueryValue)

// Two Basic headers arrive joined by a comma, which Buffer skips, and Buffer stops at the first `=`, so a credential
// that is not one base64 blob is also seen piece by piece: fields between commas or `Basic` words, without whitespace,
// split after each run of `=`. A piece under 8 characters cannot hold the word, and a credential of more than 16
// pieces is refused unread. Every pattern here is linear in a run of one character.
const notOneBlob = /[^A-Za-z0-9+/=_-]|=[A-Za-z0-9+/_-]/
const schemeWord = /\sbasic\s/i
const fieldSeparator = new RegExp(
  `,(?:${schemeWord.source})?|${schemeWord.source}`,
  schemeWord.flags,
)
const piecesOf = (credential: string): string[] =>
  credential.split(fieldSeparator, 17).flatMap((field) =>
    field
      .replace(/^\s*basic\s+/i, '')
      .replaceAll(/\s+/g, '')
      .split(/(?<==)(?!=|$)/, 17),
  )
const decodedBase64 = (text: string): string => Buffer.from(text, 'base64').toString()

function takeQueryParam(url: URL, param: string): string[] {
  const values: string[] = []
  const kept: string[] = []
  for (const pair of url.search.slice(1).split('&')) {
    const separator = pair.indexOf('=')
    const name = decodedQueryValue(separator === -1 ? pair : pair.slice(0, separator))
    if (name === param) values.push(separator === -1 ? '' : pair.slice(separator + 1))
    else kept.push(pair)
  }
  if (values.length > 0) url.search = kept.join('&')
  return values
}

type Written = { mentions: boolean; written: string; credential: string | null }

function writtenInAuthorization(header: string): Written {
  const match = /^(\w+)\s+/.exec(header)
  const credential = match === null ? '' : header.slice(match[0].length)
  switch (match?.[1]?.toLowerCase()) {
    case 'bearer':
    case 'token':
      return { mentions: mentions(header), written: header, credential }
    case 'basic':
      return writtenInBasic(header, credential)
  }
  return { mentions: mentions(header), written: header, credential: null }
}

function writtenInBasic(header: string, credential: string): Written {
  const blob = credential.replaceAll(/\s+/g, '')
  const oneBlob = !notOneBlob.test(blob) && !schemeWord.test(header)
  const userAndPassword = decodedBase64(blob)
  const pieces = oneBlob ? [] : piecesOf(credential)
  const long = pieces.slice(0, 16).filter((piece) => piece.length >= 8)
  const decoded = oneBlob ? [userAndPassword] : long.map(decodedBase64)
  const seen = decoded.find((text) => mentions(text))
  const colon = userAndPassword.indexOf(':')
  return {
    mentions:
      seen !== undefined || pieces.length > 16 || mentions(userAndPassword) || mentions(header),
    written: seen ?? header,
    credential:
      oneBlob && colon !== -1 && !mentions(userAndPassword.slice(0, colon))
        ? userAndPassword.slice(colon + 1)
        : null,
  }
}

const alone =
  (seen: (text: string) => boolean) =>
  (value: string): Written => ({ mentions: seen(value), written: value, credential: value })

function takeHeader(
  headers: Headers,
  name: string,
  read: (value: string) => Written,
  when: (written: Written) => boolean = () => true,
): Written[] {
  const value = headers.get(name)
  const taken = value === null ? [] : [read(value)].filter(when)
  if (taken.length > 0) headers.delete(name)
  return taken
}

function takeWritten(slot: CredentialSlot, headers: Headers, url: URL): Written[] {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return takeHeader(headers, 'authorization', writtenInAuthorization)
    // An SDK sends its auth token as Authorization, so a service whose slot is another header still sees a selector there.
    case 'header':
      return [
        ...takeHeader(headers, slot.header, alone(mentions)),
        ...takeHeader(
          headers,
          'authorization',
          writtenInAuthorization,
          (written) => written.mentions,
        ),
      ]
    case 'query':
      return takeQueryParam(url, slot.param).map(alone(mentionsInQuery))
  }
}

function selectorIn(
  values: readonly Written[],
  parse: (credential: string) => string | null,
): Selector {
  const naming = values.filter((value) => value.mentions)
  const [only] = values
  if (!only || naming.length === 0) return { kind: 'none' }
  const handle = values.length === 1 && only.credential !== null ? parse(only.credential) : null
  return handle !== null && !mentions(handle)
    ? { kind: 'handle', handle }
    : { kind: 'unreadable', written: naming.map(({ written }) => written).join(' | ') }
}

/** `format` keeps `/` readable, so a `%2F` means a component encoder re-encoded the value, which is decoded first. */
const reEncoded = /%2f/i

function parseQueryValue(shape: SelectorShape, value: string): string | null {
  const decoded = decodedQueryValue(value)
  const [first, second] = reEncoded.test(value) ? [decoded, value] : [value, decoded]
  const parsed = (text: string | null) => (text === null ? null : shape.parse(text))
  return parsed(first) ?? parsed(second)
}

export function readSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: Selector; stripped: { headers: Headers; url: URL } } {
  const headers = new Headers(req.headers)
  const url = new URL(req.url)
  const parse = (credential: string) =>
    slot.kind === 'query' ? parseQueryValue(shape, credential) : shape.parse(credential)
  return {
    selector: selectorIn(takeWritten(slot, headers, url), parse),
    stripped: { headers, url },
  }
}
