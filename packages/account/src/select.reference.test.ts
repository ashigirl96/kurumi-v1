import { describe, expect, test } from 'bun:test'

import {
  selectorShapeOf,
  type CredentialSlot,
  type SelectorShape,
  type ServiceId,
  type VendorId,
} from './catalog.ts'
import { decodedOnce, referenceSelection, referenceSelector } from './select.reference.ts'
import { accountHandle, readSelector, selectAccount, type GrantedCandidate } from './select.ts'

const b64 = (text: string) => Buffer.from(text).toString('base64')
const b64url = (text: string) => Buffer.from(text).toString('base64url')
const basic = (user: string, password: string) => `Basic ${b64(`${user}:${password}`)}`

function seededRandom(seed: number) {
  let state = seed
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!
  return { next, pick }
}

const labels = [
  'a',
  'b',
  'bot',
  'main',
  'Acme',
  'Acme, Inc.',
  'a@x.example',
  'a+b@x.example',
  'a b',
  'ünï',
  '50%off',
  'a%41',
  'a%2Fb',
  'kurumi-x',
  'Kurumi',
  'a, Bearer placeholder',
]
const tokens = [
  'ya29.a0AfH6SMBx',
  'sk-ant-api03-placeholder',
  'ghp_abcdefghijklmnop',
  'AIzaPlaceholder',
  'placeholder',
  '',
  b64url('{"name":"Kurumi Tanaka"}'),
]
const users = ['x', 'git', 'kurumi', 'kur%75mi', '']

const spellings: ((shape: SelectorShape, handle: string) => string)[] = [
  (shape, handle) => shape.format(handle),
  (shape, handle) => shape.format(handle),
  (_, handle) => `kurumi:${handle}`,
  (_, handle) => `KURUMI:${handle}`,
  (_, handle) => `Kurumi:${encodeURIComponent(handle)}`,
  (_, handle) => encodeURIComponent(`kurumi:${handle}`),
  (_, handle) => `kurumi:${handle}%ZZ`,
  (_, handle) => `%6Burumi:${handle}`,
  (_, handle) => `kurumi ${handle}`,
  (_, handle) => `"kurumi:${handle}"`,
  (_, handle) => b64(`kurumi:${handle}`),
  (_, handle) => `sk-ant-kurumi-${b64url(handle)}`,
  (_, handle) => `SK-ANT-KURUMI-${b64url(handle)}`,
  (_, handle) => `kuru mi:${handle}`,
  (_, handle) => `kurumj:${handle}`,
  () => 'kurumi:',
  () => 'kurumi:%E0',
  () => 'sk-ant-kurumi-***',
]
const inAuthorization: ((credential: string, user: string) => string)[] = [
  (c) => `Bearer ${c}`,
  (c) => `Bearer ${c}`,
  (c) => `Bearer ${c}`,
  (c) => `token ${c}`,
  (c) => `token ${c}`,
  (c) => `bearer\t${c}`,
  (c) => `Digest ${c}`,
  (c) => c,
  (c, user) => basic(user, c),
  (c, user) => basic(user, c),
  (c, user) => basic(user, c),
  (c) => basic(c, ''),
  (c, user) => basic(user, c).replace(/=+$/, ''),
  (c, user) => `Basic ${b64url(`${user}:${c}`)}`,
  (c, user) => `${basic(user, c)}===`,
  (c, user) => `${basic(user, c)}.`,
  (c, user) => basic(user, c).replace(/^(Basic .{6})/, '$1 '),
  (c, user) => basic(user, c).replace(/^(Basic .{8})/, '$1 '),
  (c, user) => `Basic Q ${b64(`${user}:${c}`)}`,
  (c, user) => `Basic ${b64(`${user}:placeholder`)} ${b64(`${user}:${c}`)}`,
  (c, user) => `Basic ${b64(`${user}:placeholder`)}${b64(`${user}:${c}`)}`,
  (c, user) => `${basic(user, 'placeholder')}, ${basic(user, c)}`,
  (c, user) => `${basic(user, c)}, ${basic(user, 'placeholder')}`,
  (c, user) => `${basic(user, 'placeholder')}, ${basic(user, c).replace(/^(Basic .{6})/, '$1 ')}`,
  (c, user) =>
    Array.from({ length: 17 }, (_, i) => (i === 16 ? basic(user, c) : basic(user, 'x'))).join(', '),
  (c, user) => `${basic(user, 'placeholder')} ${basic(user, c)}`,
  (c, user) => `Basic A${','.repeat(17)}${b64(`${user}:${c}`)}`,
  (c, user) => `${basic(user, 'placeholder')}${', Basic '.repeat(17)}${basic(user, c)}`,
  (c, user) => `Basic ${b64url(`${user}:${c}`)}, ${basic(user, 'placeholder')}`,
  (c, user) => `Bearer placeholder, ${basic(user, c)}`,
  (c) => `Basic ${b64(c)}`,
]
const inQuery: ((credential: string) => string)[] = [
  (c) => encodeURIComponent(c),
  (c) => encodeURIComponent(c),
  (c) => c,
  (c) => encodeURI(c),
  (c) => new URLSearchParams({ v: c }).toString().slice(2),
  (c) => encodeURIComponent(encodeURIComponent(c)),
]
const pads = [
  'kurumx '.repeat(300),
  'kuru%6D'.repeat(300),
  'QUFBQUFBQUE,'.repeat(200),
  '%25'.repeat(500),
]

type Slot = { vendor: VendorId; service: ServiceId; slot: CredentialSlot; url: string }
const slots: Slot[] = [
  {
    vendor: 'notion',
    service: 'notion',
    slot: { kind: 'bearer' },
    url: 'https://api.notion.com/v1/pages',
  },
  {
    vendor: 'github',
    service: 'github',
    slot: { kind: 'basic' },
    url: 'https://api.github.com/user',
  },
  {
    vendor: 'anthropic',
    service: 'anthropic-api',
    slot: { kind: 'header', header: 'x-api-key' },
    url: 'https://api.anthropic.com/v1/messages',
  },
  {
    vendor: 'google',
    service: 'gmail',
    slot: { kind: 'query', param: 'key' },
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
  },
]

type Case = { headers: [string, string][]; url: string; candidates: GrantedCandidate[] }

function generate({ vendor, slot, url }: Slot, random: ReturnType<typeof seededRandom>): Case {
  const shape = selectorShapeOf(vendor)
  const label = random.pick(labels)
  const handle = `${vendor}/${label}`
  const credential = () =>
    random.next() < 0.6 ? random.pick(spellings)(shape, handle) : random.pick(tokens)
  const padded = (value: string) => (random.next() < 0.02 ? value + random.pick(pads) : value)
  const authorization = () => padded(random.pick(inAuthorization)(credential(), random.pick(users)))
  const headers: [string, string][] = [['accept', 'application/json']]
  const query = random.next() < 0.5 ? ['alt=json'] : []
  const count = random.next() < 0.85 ? 1 : random.next() < 0.7 ? 2 : 0
  for (let i = 0; i < count; i++) {
    if (slot.kind === 'query') {
      const name = random.pick(['key', 'key', 'k%65y', 'KEY'])
      const at = Math.floor(random.next() * (query.length + 1))
      query.splice(at, 0, `${name}=${random.pick(inQuery)(credential())}`)
    } else if (slot.kind === 'header') {
      headers.push([
        slot.header,
        padded(random.next() < 0.8 ? credential() : `Bearer ${credential()}`),
      ])
    } else {
      headers.push(['authorization', authorization()])
    }
  }
  if (slot.kind === 'header' && random.next() < 0.4)
    headers.push(['authorization', authorization()])
  const lookalikes = [
    `${vendor}/${label.split(',')[0]}`,
    `${vendor}/${label.toLowerCase()}`,
    `${vendor}/${encodeURIComponent(label)}`,
    `${vendor}/${decodedOnce(label) ?? label}`,
    `${vendor}/main`,
    `${vendor}/${random.pick(labels)}`,
  ]
  const pool = [
    ...new Set([
      ...(random.next() < 0.8 ? [handle] : []),
      ...lookalikes.slice(0, Math.floor(random.next() * 5)),
    ]),
  ]
  const defaultAt = random.next() < 0.8 ? Math.floor(random.next() * pool.length) : -1
  const candidates = pool.map((h, i) => ({
    accountId: `acct-${i}`,
    handle: accountHandle(vendor, h.slice(vendor.length + 1)),
    isDefault: i === defaultAt,
    status: random.next() < 0.05 ? ('needs_reauth' as const) : ('active' as const),
  }))
  return { headers, url: `${url}${query.length > 0 ? `?${query.join('&')}` : ''}`, candidates }
}

const requestOf = ({ headers, url }: Case) => {
  const built = new Headers()
  for (const [name, value] of headers) built.append(name, value)
  return { headers: built, url: new URL(url) }
}
type Probe = ReturnType<typeof requestOf>

type Outcome = { selector: string; decision: string; headers: [string, string][]; url: string }

function observed({ vendor, service, slot }: Slot, c: Case, req: Probe): Outcome {
  const { selector, stripped } = readSelector(selectorShapeOf(vendor), slot, req)
  const selection = selectAccount(service, c.candidates, selector)
  return {
    selector:
      selector.kind === 'handle'
        ? `handle ${selector.handle}`
        : selector.kind === 'unreadable'
          ? 'refused'
          : 'none',
    decision: selection.ok ? `${selection.how} ${selection.accountId}` : selection.refusal.code,
    headers: [...stripped.headers.entries()],
    url: stripped.url.href,
  }
}

function expected({ vendor, slot }: Slot, c: Case, req: Probe): Outcome {
  const { selector, stripped } = referenceSelector(selectorShapeOf(vendor), slot, req)
  const decision = referenceSelection(c.candidates, selector)
  return {
    selector: selector.kind === 'handle' ? `handle ${selector.handle}` : selector.kind,
    decision: decision.ok ? `${decision.how} ${decision.accountId}` : decision.code,
    headers: [...stripped.headers.entries()],
    url: stripped.url.href,
  }
}

describe('readSelector and selectAccount agree with the reference rule', () => {
  test.each(slots.map((target) => [target.slot.kind, target] as const))(
    'the %s slot, over 4000 seeded cases with single-grant and default groups',
    (_kind, target) => {
      const random = seededRandom(20261022)
      const seen = { named: 0, refused: 0, none: 0, single: 0 }
      for (let i = 0; i < 4000; i++) {
        const c = generate(target, random)
        const req = requestOf(c)
        const want = expected(target, c, req)
        const got = observed(target, c, req)
        if (!Bun.deepEquals(got, want)) expect({ case: c, got }).toEqual({ case: c, got: want })
        if (want.selector.startsWith('handle')) seen.named++
        else if (want.selector === 'refused') seen.refused++
        else seen.none++
        if (c.candidates.length === 1) seen.single++
      }
      expect(seen).toSatisfy((counts) => Object.values(counts).every((count) => count > 150))
    },
  )
})
