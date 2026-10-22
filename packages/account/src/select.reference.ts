import { wasReEncoded, type CredentialSlot, type SelectorShape } from './catalog.ts'
import type { GrantedCandidate, Selection, SelectionRefusal } from './select.ts'

export type ReferenceSelector =
  | { kind: 'handle'; handle: string }
  | { kind: 'refused' }
  | { kind: 'none' }

const word = /kurumi/i

const decodedOnce = (text: string): string | null => {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

const mentions = (text: string): boolean => word.test(text) || word.test(decodedOnce(text) ?? '')

const asQueryWrites = (value: string): string => value.replaceAll('+', ' ')

// Two Basic headers arrive joined by a comma, so every base64 run of the credential is decoded to see the word.
const notBase64 = /[^A-Za-z0-9+/=_-]+/
const decodedBase64 = (text: string): string => Buffer.from(text, 'base64').toString()

type Value = { mentions: boolean; credential: string | null }

function valueInAuthorization(header: string): Value {
  const [, scheme = '', credential = ''] = /^(\w+)\s+(.+)$/.exec(header) ?? []
  switch (scheme.toLowerCase()) {
    case 'bearer':
    case 'token':
      return { mentions: mentions(header), credential }
    case 'basic': {
      const blob = credential.replaceAll(/\s+/g, '')
      const runs = [...new Set([blob, ...credential.split(notBase64)])].map(decodedBase64)
      const [user = '', ...password] = decodedBase64(blob).split(':')
      return {
        mentions: mentions(header) || runs.some(mentions),
        credential:
          !notBase64.test(blob) && password.length > 0 && !mentions(user)
            ? password.join(':')
            : null,
      }
    }
  }
  return { mentions: mentions(header), credential: null }
}

const valueInHeader = (value: string): Value => ({ mentions: mentions(value), credential: value })

const valueInQuery = (value: string): Value => ({
  mentions: mentions(asQueryWrites(value)),
  credential: value,
})

function takeHeader(headers: Headers, name: string): string[] {
  const value = headers.get(name)
  headers.delete(name)
  return value === null ? [] : [value]
}

function takeQueryParam(url: URL, param: string): string[] {
  const values: string[] = []
  const kept: string[] = []
  for (const pair of url.search.slice(1).split('&')) {
    const separator = pair.indexOf('=')
    const name = decodedOnce(asQueryWrites(separator === -1 ? pair : pair.slice(0, separator)))
    if (name === param) values.push(separator === -1 ? '' : pair.slice(separator + 1))
    else kept.push(pair)
  }
  if (values.length > 0) url.search = kept.join('&')
  return values
}

function takeValues(slot: CredentialSlot, headers: Headers, url: URL): Value[] {
  switch (slot.kind) {
    case 'bearer':
    case 'basic':
      return takeHeader(headers, 'authorization').map(valueInAuthorization)
    case 'header': {
      const own = takeHeader(headers, slot.header).map(valueInHeader)
      const authorization = headers.get('authorization')
      const second = authorization === null ? null : valueInAuthorization(authorization)
      if (second === null || !second.mentions) return own
      headers.delete('authorization')
      return [...own, second]
    }
    case 'query':
      return takeQueryParam(url, slot.param).map(valueInQuery)
  }
}

function parseQueryValue(shape: SelectorShape, value: string): string | null {
  const decoded = decodedOnce(asQueryWrites(value))
  const order = wasReEncoded(value) ? [decoded, value] : [value, decoded]
  for (const text of order) {
    const handle = text === null ? null : shape.parse(text)
    if (handle !== null) return handle
  }
  return null
}

export function referenceSelector(
  shape: SelectorShape,
  slot: CredentialSlot,
  req: { headers: Headers; url: URL },
): { selector: ReferenceSelector; stripped: { headers: Headers; url: URL } } {
  const headers = new Headers(req.headers)
  const url = new URL(req.url)
  const values = takeValues(slot, headers, url)
  const stripped = { headers, url }
  if (!values.some((value) => value.mentions)) return { selector: { kind: 'none' }, stripped }
  const [only] = values
  const credential = only && values.length === 1 ? only.credential : null
  const handle =
    credential === null
      ? null
      : slot.kind === 'query'
        ? parseQueryValue(shape, credential)
        : shape.parse(credential)
  if (handle === null || mentions(handle)) return { selector: { kind: 'refused' }, stripped }
  return { selector: { kind: 'handle', handle }, stripped }
}

export type ReferenceDecision =
  | { ok: true; accountId: string; how: Extract<Selection, { ok: true }>['how'] }
  | { ok: false; code: SelectionRefusal['code'] }

const use = (candidate: GrantedCandidate, how: 'named' | 'only' | 'default'): ReferenceDecision =>
  candidate.status === 'needs_reauth'
    ? { ok: false, code: 'account_needs_reauth' }
    : { ok: true, accountId: candidate.accountId, how }

export function referenceSelection(
  candidates: readonly GrantedCandidate[],
  selector: ReferenceSelector,
): ReferenceDecision {
  if (selector.kind === 'refused') return { ok: false, code: 'account_not_granted' }
  if (selector.kind === 'handle') {
    const match = candidates.find((candidate) => candidate.handle === selector.handle)
    return match ? use(match, 'named') : { ok: false, code: 'account_not_granted' }
  }
  const [first] = candidates
  if (!first) return { ok: false, code: 'account_not_connected' }
  if (candidates.length === 1) return use(first, 'only')
  const defaults = candidates.filter((candidate) => candidate.isDefault)
  const [preferred] = defaults
  if (preferred && defaults.length === 1) return use(preferred, 'default')
  return { ok: false, code: 'account_ambiguous' }
}
