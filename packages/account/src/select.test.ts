import { describe, expect, test } from 'bun:test'

import {
  defaultSelectorShape,
  selectorShapeOf,
  serviceIds,
  serviceSpec,
  vendorIds,
  vendorOf,
  type CredentialSlot,
  type SelectorShape,
  type ServiceId,
  type VendorId,
} from './catalog.ts'
import {
  accountHandle,
  readSelector,
  selectAccount,
  type AccountHandle,
  type GrantedCandidate,
  type Selection,
  type Selector,
} from './select.ts'

const handleA = accountHandle('google', 'a@work.example')
const handleB = accountHandle('google', 'b@work.example')
const handleC = accountHandle('google', 'c@work.example')

const grant = (
  handle: AccountHandle,
  options: { isDefault?: boolean; status?: GrantedCandidate['status'] } = {},
): GrantedCandidate => ({
  accountId: `id-${handle}`,
  handle,
  isDefault: options.isDefault ?? false,
  status: options.status ?? 'active',
})

const none: Selector = { kind: 'none' }
const named = (handle: string): Selector => ({ kind: 'handle', handle })

const grantA = grant(handleA, { isDefault: true })
const grantB = grant(handleB)
const grantC = grant(handleC)
const calendarA = grant(handleA)
const group1Gmail = [grantA, grantB, grantC]
const group2Gmail = [grantB]
const group2Calendar = [calendarA]

const ok = (candidate: GrantedCandidate, how: 'named' | 'only' | 'default'): Selection => ({
  ok: true,
  accountId: candidate.accountId,
  handle: candidate.handle,
  how,
})

describe('selectAccount over the Group 1 and Group 2 grants', () => {
  const rows: [string, ServiceId, GrantedCandidate[], Selector, Selection][] = [
    [
      'group 1 gmail, nothing named: the default A',
      'gmail',
      group1Gmail,
      none,
      ok(grantA, 'default'),
    ],
    ['group 1 gmail names B: B', 'gmail', group1Gmail, named(handleB), ok(grantB, 'named')],
    ['group 1 gmail names C: C', 'gmail', group1Gmail, named(handleC), ok(grantC, 'named')],
    [
      'group 1 gmail names the default A: named, not default',
      'gmail',
      group1Gmail,
      named(handleA),
      ok(grantA, 'named'),
    ],
    [
      'group 1 gmail names an account it was not granted',
      'gmail',
      group1Gmail,
      named('google/d@work.example'),
      {
        ok: false,
        refusal: {
          code: 'account_not_granted',
          service: 'gmail',
          named: 'google/d@work.example',
          granted: [handleA, handleB, handleC],
        },
      },
    ],
    ['group 2 gmail, nothing named: the only B', 'gmail', group2Gmail, none, ok(grantB, 'only')],
    ['group 2 gmail names B: named', 'gmail', group2Gmail, named(handleB), ok(grantB, 'named')],
    [
      'group 2 gmail names A, which it holds only for calendar',
      'gmail',
      group2Gmail,
      named(handleA),
      {
        ok: false,
        refusal: {
          code: 'account_not_granted',
          service: 'gmail',
          named: handleA,
          granted: [handleB],
        },
      },
    ],
    [
      'group 2 calendar, nothing named: the only A',
      'google-calendar',
      group2Calendar,
      none,
      ok(calendarA, 'only'),
    ],
    [
      'group 2 calendar names B, which it holds only for gmail',
      'google-calendar',
      group2Calendar,
      named(handleB),
      {
        ok: false,
        refusal: {
          code: 'account_not_granted',
          service: 'google-calendar',
          named: handleB,
          granted: [handleA],
        },
      },
    ],
    [
      'group 1 calendar has no grant',
      'google-calendar',
      [],
      none,
      { ok: false, refusal: { code: 'account_not_connected', service: 'google-calendar' } },
    ],
    [
      'no grant and a handle named: the named handle is not granted',
      'gmail',
      [],
      named(handleA),
      {
        ok: false,
        refusal: { code: 'account_not_granted', service: 'gmail', named: handleA, granted: [] },
      },
    ],
  ]

  test.each(rows)('%s', (_name, service, candidates, selector, expected) => {
    expect(selectAccount(service, candidates, selector)).toEqual(expected)
  })

  test('several grants with no default and nothing named is ambiguous and lists the granted handles', () => {
    const candidates = [grant(handleA), grant(handleB), grant(handleC)]

    expect(selectAccount('gmail', candidates, none)).toEqual({
      ok: false,
      refusal: {
        code: 'account_ambiguous',
        service: 'gmail',
        granted: [handleA, handleB, handleC],
      },
    })
  })

  test('a default that is not the first row is still the default', () => {
    const candidates = [grant(handleA), grant(handleB), grant(handleC, { isDefault: true })]

    expect(selectAccount('gmail', candidates, none)).toEqual(ok(candidates[2]!, 'default'))
  })

  test('a name beats the default and the order of the rows', () => {
    const candidates = [grant(handleA, { isDefault: true }), grant(handleB), grant(handleC)]

    expect(selectAccount('gmail', candidates.toReversed(), named(handleB))).toEqual(
      ok(candidates[1]!, 'named'),
    )
  })

  test('a handle that is a prefix or a suffix of a granted one is not granted', () => {
    const candidates = [grant(handleA), grant(accountHandle('google', 'ab@work.example'))]

    for (const namedCount of [
      'google/a',
      'google/a@work.example ',
      'google/@work.example',
      'a@work.example',
    ]) {
      expect(selectAccount('gmail', candidates, named(namedCount))).toMatchObject({
        ok: false,
        refusal: { code: 'account_not_granted', named: namedCount },
      })
    }
  })

  test('two defaults are ambiguous, never the first row', () => {
    const candidates = [grant(handleA, { isDefault: true }), grant(handleB, { isDefault: true })]

    expect(selectAccount('gmail', candidates, none)).toMatchObject({
      ok: false,
      refusal: { code: 'account_ambiguous' },
    })
  })

  test('a selector that could not be read is refused whatever the grants, naming what was written', () => {
    const written = 'Bearer kurumi:google/a@work.example, Bearer kurumi:google/b'

    for (const candidates of [[grantA], group1Gmail, []]) {
      expect(selectAccount('gmail', candidates, { kind: 'unreadable', written })).toEqual({
        ok: false,
        refusal: {
          code: 'account_not_granted',
          service: 'gmail',
          named: written,
          granted: candidates.map(({ handle }) => handle),
        },
      })
    }
  })

  test('what was written is never matched against the granted handles', () => {
    const candidates = [grant(accountHandle('google', 'kurumi-team'))]

    expect(
      selectAccount('gmail', candidates, { kind: 'unreadable', written: 'google/kurumi-team' }),
    ).toMatchObject({ ok: false, refusal: { code: 'account_not_granted' } })
  })

  test('a handle is matched exactly', () => {
    const selection = selectAccount('gmail', group1Gmail, named(handleA.toUpperCase()))

    expect(selection).toMatchObject({ ok: false, refusal: { code: 'account_not_granted' } })
  })
})

const dead = (handle: AccountHandle, isDefault = false) =>
  grant(handle, { isDefault, status: 'needs_reauth' })
const needsReauth = (handle: AccountHandle): Selection => ({
  ok: false,
  refusal: { code: 'account_needs_reauth', service: 'gmail', handle },
})

describe('selectAccount with a dead refresh token', () => {
  test('naming an account that needs reauth says so', () => {
    expect(selectAccount('gmail', [dead(handleA), grant(handleB)], named(handleA))).toEqual(
      needsReauth(handleA),
    )
  })

  test('the only grant needing reauth says so', () => {
    expect(selectAccount('gmail', [dead(handleA)], none)).toEqual(needsReauth(handleA))
  })

  test('a default needing reauth says so instead of falling back to another account', () => {
    expect(selectAccount('gmail', [dead(handleA, true), grant(handleB)], none)).toEqual(
      needsReauth(handleA),
    )
  })

  test('an account that needs reauth does not block naming a healthy one', () => {
    const healthy = grant(handleB)

    expect(selectAccount('gmail', [dead(handleA, true), healthy], named(handleB))).toEqual(
      ok(healthy, 'named'),
    )
  })
})

describe('selectAccount invariants', () => {
  const pool = [handleA, handleB, handleC]
  const selectors: Selector[] = [
    none,
    named(handleA),
    named(handleC),
    named('google/unknown@x.example'),
    { kind: 'unreadable', written: handleA },
  ]

  function* groups(): Generator<GrantedCandidate[]> {
    for (let mask = 0; mask < 8; mask++) {
      const members = pool.filter((_, i) => mask & (1 << i))
      for (let defaultIndex = -1; defaultIndex < members.length; defaultIndex++) {
        for (const status of ['active', 'needs_reauth'] as const) {
          yield members.map((handle, i) => grant(handle, { isDefault: i === defaultIndex, status }))
        }
      }
    }
  }

  test('the chosen account is always one of the candidates, and a named candidate is always chosen', () => {
    let checked = 0
    for (const candidates of groups()) {
      for (const selector of selectors) {
        const selection = selectAccount('gmail', candidates, selector)
        checked++
        if (selection.ok) {
          expect(candidates.map((c) => c.accountId)).toContain(selection.accountId)
          expect(candidates.find((c) => c.accountId === selection.accountId)?.status).toBe('active')
        }
        const match =
          selector.kind === 'handle' && candidates.find((c) => c.handle === selector.handle)
        if (match && match.status === 'active') expect(selection).toEqual(ok(match, 'named'))
        if (selection.ok && selection.how === 'only') expect(candidates).toHaveLength(1)
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  test('a refusal never names a handle outside the candidates', () => {
    for (const candidates of groups()) {
      for (const selector of selectors) {
        const selection = selectAccount('gmail', candidates, selector)
        if (selection.ok) continue
        const { refusal } = selection
        const mentioned =
          refusal.code === 'account_ambiguous' || refusal.code === 'account_not_granted'
            ? refusal.granted
            : refusal.code === 'account_needs_reauth'
              ? [refusal.handle]
              : []
        for (const handle of mentioned) expect(candidates.map((c) => c.handle)).toContain(handle)
      }
    }
  })
})

const request = (init: {
  headers?: Record<string, string> | [string, string][]
  url?: string
}) => ({
  headers: new Headers(init.headers),
  url: new URL(init.url ?? 'https://www.googleapis.com/gmail/v1/users/me/messages'),
})
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

describe('readSelector', () => {
  const handle = 'google/alice@work.example'

  test('reads the handle, removes the credential header and leaves the rest of the request', () => {
    const req = request({
      headers: { Authorization: `Bearer kurumi:${handle}`, accept: 'application/json' },
    })

    const { selector, stripped } = readSelector(defaultSelectorShape, { kind: 'bearer' }, req)

    expect(selector).toEqual(named(handle))
    expect(stripped.headers.has('authorization')).toBe(false)
    expect(stripped.headers.get('accept')).toBe('application/json')
    expect(stripped.url.href).toBe(req.url.href)
  })

  test('removes only the header of the slot', () => {
    const shape = selectorShapeOf('anthropic')
    const req = request({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'X-Api-Key': shape.format('anthropic/team'), authorization: 'Bearer untouched' },
    })

    const { selector, stripped } = readSelector(shape, { kind: 'header', header: 'x-api-key' }, req)

    expect(selector).toEqual(named('anthropic/team'))
    expect(stripped.headers.has('x-api-key')).toBe(false)
    expect(stripped.headers.get('authorization')).toBe('Bearer untouched')
  })

  test('the request that came in is left as it was', () => {
    const req = request({
      headers: { authorization: `Bearer kurumi:${handle}` },
      url: 'https://h.example/x?key=kurumi:google/a@x',
    })

    readSelector(defaultSelectorShape, { kind: 'bearer' }, req)
    readSelector(defaultSelectorShape, { kind: 'query', param: 'key' }, req)

    expect(req.headers.get('authorization')).toBe(`Bearer kurumi:${handle}`)
    expect(req.url.href).toBe('https://h.example/x?key=kurumi:google/a@x')
  })

  test('the scheme and the prefix are read without regard to case', () => {
    const { selector } = readSelector(
      defaultSelectorShape,
      { kind: 'bearer' },
      request({ headers: { authorization: `bEaReR KURUMI:${handle}` } }),
    )

    expect(selector).toEqual(named(handle))
  })

  test('a password that holds a colon keeps everything after the first colon', () => {
    const { selector } = readSelector(
      defaultSelectorShape,
      { kind: 'basic' },
      request({ headers: { authorization: basic('x', 'kurumi:github/a:b') } }),
    )

    expect(selector).toEqual(named('github/a:b'))
  })

  test.each([
    ['no header', {}],
    ['a scheme that carries no secret', { authorization: 'Digest username="x"' }],
    ['an empty Basic credential', { authorization: 'Basic' }],
    ['a Basic credential that is no base64', { authorization: 'Basic !!!' }],
    ['a Basic credential with no password', { authorization: basic('no-colon', '').slice(0, -1) }],
  ])('%s is none, and the slot is still empty', (_name, headers) => {
    const { selector, stripped } = readSelector(
      defaultSelectorShape,
      { kind: 'basic' },
      request({ headers }),
    )

    expect(selector).toEqual(none)
    expect(stripped.headers.has('authorization')).toBe(false)
  })

  test('a url that has no key parameter is left alone', () => {
    const { selector, stripped } = readSelector(
      defaultSelectorShape,
      { kind: 'query', param: 'key' },
      request({ url: 'https://h.example/x?a=1&apikey=2&key2=3&Key=4' }),
    )

    expect(selector).toEqual(none)
    expect(stripped.url.href).toBe('https://h.example/x?a=1&apikey=2&key2=3&Key=4')
  })
})

type Target = { vendor: VendorId; service: ServiceId; slot: CredentialSlot; shape: SelectorShape }
type Row = [name: string, value: string, expected: string]
type Placement = { name: string; wrap: (secret: string) => string }

const headerOf = (slot: CredentialSlot): string =>
  slot.kind === 'header' ? slot.header : 'authorization'

const groupOf = (vendor: VendorId): GrantedCandidate[] => [
  grant(accountHandle(vendor, 'main'), { isDefault: true }),
  ...[
    'a',
    'b',
    'Acme',
    'Acme, Inc.',
    'Acme, token team',
    'kurumi-team',
    'a@x.example',
    'a+b@x.example',
    'a+tag@x.example',
  ].map((label) => grant(accountHandle(vendor, label))),
]

function decide(
  { vendor, service, slot, shape }: Target,
  req: ReturnType<typeof request>,
): { outcome: string; stripped: ReturnType<typeof request> } {
  const { selector, stripped } = readSelector(shape, slot, req)
  const selection = selectAccount(service, groupOf(vendor), selector)
  if (!selection.ok) return { outcome: 'refused', stripped }
  return { outcome: selection.how === 'named' ? selection.handle : selection.how, stripped }
}

const bearer = (scheme: string): Placement => ({ name: scheme, wrap: (s) => `${scheme} ${s}` })

const placementsOf = (slot: CredentialSlot): Placement[] => {
  switch (slot.kind) {
    case 'bearer':
      return [bearer('Bearer'), bearer('token')]
    case 'basic':
      return [{ name: 'Basic', wrap: (secret) => basic('x', secret) }]
    case 'header':
      return [{ name: slot.header, wrap: (secret) => secret }]
    case 'query':
      return []
  }
}

const slotTargets: Target[] = [
  ...new Map(
    serviceIds.flatMap((service) => {
      const { slot } = serviceSpec(service)
      const vendor = vendorOf(service)
      const shape = selectorShapeOf(vendor)
      const key = `${slot.kind} ${shape === defaultSelectorShape ? 'default' : vendor}`
      return slot.kind === 'query' ? [] : [[key, { vendor, service, slot, shape }] as const]
    }),
  ).values(),
]

const joined = (...values: string[]) => values.join(', ')

function rowsOf({ vendor, shape }: Target, { wrap }: Placement): Row[] {
  const handle = (label: string) => `${vendor}/${label}`
  const written = (label: string) => `kurumi:${handle(label)}`
  const forms =
    shape === defaultSelectorShape ? [written] : [written, (l: string) => shape.format(handle(l))]
  const placeholder = wrap('placeholder')
  return [
    ...forms.flatMap((form, i): Row[] => [
      [`form ${i}: one selector`, wrap(form('b')), handle('b')],
      [`form ${i}: two different selectors`, joined(wrap(form('a')), wrap(form('b'))), 'refused'],
      [`form ${i}: the same selector twice`, joined(wrap(form('a')), wrap(form('a'))), 'refused'],
      [`form ${i}: a placeholder before`, joined(placeholder, wrap(form('a'))), 'refused'],
      [`form ${i}: a placeholder after`, joined(wrap(form('a')), placeholder), 'refused'],
    ]),
    ...forms
      .slice(1)
      .map((form): Row => [
        'a comma in a label of the vendor shape',
        wrap(form('Acme, Inc.')),
        handle('Acme, Inc.'),
      ]),
    ['capitals in the prefix', wrap(`KURUMI:${handle('b')}`), handle('b')],
    ['a comma and a space in the label', wrap(written('Acme, Inc.')), handle('Acme, Inc.')],
    [
      'a scheme word after the comma',
      wrap(written('Acme, token team')),
      handle('Acme, token team'),
    ],
    ['a comma written %2C', wrap(written('Acme%2C%20Inc.')), handle('Acme, Inc.')],
    [
      'a selector and a real-looking key',
      wrap(`${written('main')}, sk-ant-api03-placeholder`),
      'refused',
    ],
    ['a label that mentions the word', wrap(written('kurumi-team')), 'refused'],
    ['an encoded prefix', wrap(`kurumi%3A${vendor}%2Fa`), 'refused'],
    ['the word hidden by an escape', wrap(`%6Burumi:${handle('a')}`), 'refused'],
    ['an empty handle', wrap('kurumi:'), 'refused'],
    ['a malformed escape', wrap('kurumi:%E0'), 'refused'],
    ['an anthropic look-alike', wrap('sk-ant-kurumi-***'), 'refused'],
    ['an anthropic prefix alone', wrap('sk-ant-kurumi-'), 'refused'],
    ['an anthropic payload that is not canonical', wrap('sk-ant-kurumi-YQ=='), 'refused'],
    ['a real-looking token', wrap('ya29.real-looking'), 'default'],
    ['the SDK placeholder', placeholder, 'default'],
  ]
}

function oddRowsOf({ vendor, slot, shape }: Target): Row[] {
  const selector = `kurumi:${vendor}/a`
  const hidden = (place: (secret: string) => string): Row[] => [
    [
      'a base64 token that decodes to a selector',
      place(Buffer.from(selector).toString('base64')),
      'refused',
    ],
    [
      'a base64 token after a colon',
      place(`x:${Buffer.from(selector).toString('base64')}`),
      'refused',
    ],
    ['an escaped letter of the word and a bad escape', place(`%6Burumi:${vendor}/a%E0`), 'refused'],
  ]
  if (slot.kind === 'header') {
    return [
      ['a bearer scheme before the selector', `Bearer ${selector}`, 'refused'],
      [
        'a bearer scheme before the vendor shape',
        `Bearer ${shape.format(`${vendor}/a`)}`,
        'refused',
      ],
      ...hidden((secret) => secret),
    ]
  }
  return [
    ['a quoted selector', `Bearer "${selector}"`, 'refused'],
    ['a scheme that is not a bearer', `Digest ${selector}`, 'refused'],
    ['an unknown scheme', `OAuth ${selector}`, 'refused'],
    ['no scheme', selector, 'refused'],
    ['a colon for the space', `Bearer:${selector}`, 'refused'],
    ['a word before the selector', `Bearer x ${selector}`, 'refused'],
    ['the selector as the Basic user (git token-as-user)', basic(selector, ''), 'refused'],
    ['the selector as the whole Basic credential', basic('kurumi', `${vendor}/a`), 'refused'],
    [
      'the word in the Basic user and a selector as the password',
      basic('kurumi', selector),
      'refused',
    ],
    [
      'the word in a Basic credential that is no selector once decoded',
      'Basic kurumiAAAA',
      'refused',
    ],
    [
      'a Basic credential split by a space',
      `Basic ${Buffer.from(`x:${selector}`)
        .toString('base64')
        .replace(/^(.{8})/, '$1 ')}`,
      'refused',
    ],
    ...hidden((secret) => `Bearer ${secret}`),
  ]
}

describe.each(
  slotTargets.map((target) => [`${target.vendor} ${target.slot.kind}`, target] as const),
)('a selector written into the %s slot', (_slot, target) => {
  const header = headerOf(target.slot)
  const expectOutcome = ([, value, expected]: Row) => {
    const { outcome, stripped } = decide(target, request({ headers: { [header]: value } }))

    expect(stripped.headers.has(header)).toBe(false)
    expect(outcome).toBe(expected)
  }
  const placements = placementsOf(target.slot)

  test('every row is a different input', () => {
    const values = [...placements.flatMap((p) => rowsOf(target, p)), ...oddRowsOf(target)].map(
      ([, value]) => value,
    )

    expect(new Set(values).size).toBe(values.length)
  })

  describe.each(placements.map((placement) => [placement.name, placement] as const))(
    'as %s',
    (_placement, placement) => {
      test.each(rowsOf(target, placement))('%s', (name, value, expected) =>
        expectOutcome([name, value, expected]),
      )
    },
  )

  test.each(oddRowsOf(target))('%s', (name, value, expected) =>
    expectOutcome([name, value, expected]),
  )

  test('no header is none', () => {
    const { outcome, stripped } = decide(target, request({}))

    expect(outcome).toBe('default')
    expect(stripped.headers.has(header)).toBe(false)
  })
})

describe('the Authorization header of a service whose slot is another header', () => {
  const target = slotTargets.find(({ slot }) => slot.kind === 'header')!
  const apiKey = target.shape.format('anthropic/b')

  test.each([
    ['names the account', { authorization: 'Bearer kurumi:anthropic/b' }, 'anthropic/b'],
    [
      'is refused beside an x-api-key selector',
      { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      'refused',
    ],
    [
      'is refused beside an x-api-key placeholder',
      { authorization: 'Bearer kurumi:anthropic/b', 'x-api-key': 'sk-ant-api03-placeholder' },
      'refused',
    ],
    ['is refused when it is a look-alike', { authorization: 'Bearer kurumi:' }, 'refused'],
    [
      'is none when it holds an SDK placeholder',
      { authorization: 'Bearer placeholder' },
      'default',
    ],
  ])('%s', (_name, headers, expected) => {
    const { outcome, stripped } = decide(target, request({ headers }))

    expect(outcome).toBe(expected)
    expect(stripped.headers.has('authorization')).toBe(expected === 'default')
  })
})

describe('an Authorization header read for the bearer and the basic slot alike', () => {
  const schemes: [string, string][] = [
    ['Bearer', 'Bearer kurumi:github/bot'],
    ['token', 'token kurumi:github/bot'],
    ['Basic', basic('x-access-token', 'kurumi:github/bot')],
  ]

  test.each(
    schemes.flatMap(
      ([scheme, value]) =>
        [
          ['bearer', scheme, value],
          ['basic', scheme, value],
        ] as const,
    ),
  )('the %s slot reads the %s scheme', (kind, _scheme, authorization) => {
    const { selector, stripped } = readSelector(
      defaultSelectorShape,
      { kind },
      request({ headers: { authorization }, url: 'https://github.com/o/r.git/info/refs' }),
    )

    expect(selector).toEqual(named('github/bot'))
    expect(stripped.headers.has('authorization')).toBe(false)
  })
})

const search = (query: string) => request({ url: `https://h.example/x${query}` })

describe('a selector written into the query slot', () => {
  const slot: CredentialSlot = { kind: 'query', param: 'key' }
  const target: Target = { vendor: 'google', service: 'gmail', slot, shape: defaultSelectorShape }

  const rows: Row[] = [
    ['an encoded selector', '?key=kurumi%3Agoogle%2Fa%40x.example', 'google/a@x.example'],
    ['a selector as written', '?key=kurumi:google/a', 'google/a'],
    ['a label with a comma', '?key=kurumi:google/Acme, Inc.', 'google/Acme, Inc.'],
    ['a plus written by hand', '?key=kurumi:google/a+b@x.example', 'google/a+b@x.example'],
    ['an encoded plus', '?key=kurumi%3Agoogle%2Fa%2Btag%40x.example', 'google/a+tag@x.example'],
    ['a placeholder first', '?key=AIzaPlaceholder&key=kurumi%3Agoogle%2Fa', 'refused'],
    ['a placeholder last', '?key=kurumi%3Agoogle%2Fa&key=AIzaPlaceholder', 'refused'],
    ['an empty value first', '?key=&key=kurumi%3Agoogle%2Fa', 'refused'],
    ['two different selectors', '?key=kurumi:google/a&key=kurumi:google/b', 'refused'],
    ['the same selector twice', '?key=kurumi:google/a&key=kurumi%3Agoogle%2Fa', 'refused'],
    ['an encoded prefix twice over', '?key=kurumi%253Agoogle%252Fa', 'refused'],
    ['an empty handle', '?key=kurumi:', 'refused'],
    ['a malformed escape', '?key=kurumi:%E0', 'refused'],
    ['a label that mentions the word', '?key=kurumi:google/kurumi-x', 'refused'],
    ['a parameter name with an escape', '?k%65y=kurumi:google/a', 'google/a'],
    ['a bad escape beside an escaped letter', '?key=%6Burumi%3Agoogle%2Fa%ZZ', 'refused'],
    ['a base64 token after an escaped space', '?key=x%20a3VydW1pOmdvb2dsZS9h', 'refused'],
    ['a Kelvin sign for the k', '?key=%E2%84%AAurumi%3Agoogle%2Fa', 'refused'],
    ['a real-looking key', '?key=AIzaPlaceholder', 'default'],
    ['an empty key', '?key=', 'default'],
    ['no key', '?alt=json', 'default'],
  ]

  test.each(rows)('%s', (_name, query, expected) => {
    const { outcome, stripped } = decide(target, search(query))

    expect(outcome).toBe(expected)
    expect(stripped.url.searchParams.has('key')).toBe(false)
  })

  test('only the key parameter is removed and the rest stays as written', () => {
    const { stripped } = decide(
      target,
      request({
        url: 'https://example.googleapis.com/x?q=a%20b&key=kurumi%3Agoogle%2Fa%40x.example&alt=json#top',
      }),
    )

    expect(stripped.url.href).toBe('https://example.googleapis.com/x?q=a%20b&alt=json#top')
  })

  test('a url whose only parameter is the key loses its query entirely', () => {
    const { stripped } = decide(target, search('?key=kurumi:google/a'))

    expect(stripped.url.href).toBe('https://h.example/x')
  })

  test('every repeated key parameter is removed', () => {
    const { stripped } = decide(target, search('?key=kurumi:google/a&k=1&key=x&Key=2'))

    expect(stripped.url.search).toBe('?k=1&Key=2')
  })
})

describe('awkward handles through every slot', () => {
  const shapes = [...new Set(vendorIds.map(selectorShapeOf))]
  const place: [string, CredentialSlot, (value: string) => Parameters<typeof request>[0]][] = [
    ['bearer', { kind: 'bearer' }, (value) => ({ headers: { authorization: `Bearer ${value}` } })],
    [
      'header',
      { kind: 'header', header: 'x-api-key' },
      (value) => ({ headers: { 'x-api-key': value } }),
    ],
    ['basic', { kind: 'basic' }, (value) => ({ headers: { authorization: basic('x', value) } })],
    [
      'query',
      { kind: 'query', param: 'key' },
      (value) => ({ url: `https://h.example/x?${new URLSearchParams({ key: value })}` }),
    ],
  ]
  const handles = [
    'notion/ノート 共有',
    'google/a+tag@x.example',
    'github/a b',
    'google/日本語+ @x.example',
    'github/100%',
    'google/a%41b',
    'github/a%2Fb',
  ]

  describe.each(shapes.map((shape, i) => [`shape ${i}`, shape] as const))('%s', (_name, shape) => {
    test.each(place)('%s slot', (_slot, slot, placed) => {
      for (const handle of handles) {
        const { selector } = readSelector(shape, slot, request(placed(shape.format(handle))))

        expect(selector).toEqual(named(handle))
      }
    })
  })

  test.each([
    'google/a&b@x.example',
    'google/a+b@x.example',
    'notion/a#b=c d',
    'github/a;b',
    'google/a%41b',
    'github/a%2Fb',
    'github/%41',
    'notion/50%25off',
    'google/a%2Bb@x.example',
    'github/100%',
  ])('the selector %s can be pasted into the query slot as it is', (label) => {
    const raw = `https://h.example/x?alt=json&key=${defaultSelectorShape.format(label)}&q=1`

    const { selector, stripped } = readSelector(
      defaultSelectorShape,
      { kind: 'query', param: 'key' },
      request({ url: raw }),
    )

    expect(selector).toEqual(named(label))
    expect(stripped.url.href).toBe('https://h.example/x?alt=json&q=1')
  })

  test.each([
    'google/a b',
    'google/日本語',
    'google/a%41b',
    'github/a%2Fb',
    'google/a+b@x.example',
  ])('the selector %s survives an encoder that keeps the colon readable', (label) => {
    const written = encodeURIComponent(defaultSelectorShape.format(label)).replaceAll('%3A', ':')

    const { selector } = readSelector(
      defaultSelectorShape,
      { kind: 'query', param: 'key' },
      request({ url: `https://h.example/x?key=${written}` }),
    )

    expect(selector).toEqual(named(label))
  })

  test('a pasted selector names the account it was formatted from, not a lookalike', () => {
    const formatted = defaultSelectorShape.format('google/a%41b')
    const { selector } = readSelector(
      defaultSelectorShape,
      { kind: 'query', param: 'key' },
      request({ url: `https://h.example/x?key=${formatted}` }),
    )

    expect(
      selectAccount(
        'gmail',
        [grant(accountHandle('google', 'aAb')), grant(accountHandle('google', 'a%41b'))],
        selector,
      ),
    ).toMatchObject({ ok: true, handle: 'google/a%41b', how: 'named' })
  })
})

const base64Edge = /(^|[^A-Za-z0-9+/=_-])a3VydW1p($|[^A-Za-z0-9+/=_-])/
const mentions = (text: string) =>
  /kurumi/i.test(text.replace(/%6b/gi, 'k')) || base64Edge.test(text)

function handleThatTextNames(text: string): string | null {
  const prefix = /^kurumi:/i.exec(text)
  if (prefix) {
    try {
      return decodeURIComponent(text.slice(prefix[0].length))
    } catch {
      return null
    }
  }
  const anthropic = /^sk-ant-kurumi-/i.exec(text)
  return anthropic ? Buffer.from(text.slice(anthropic[0].length), 'base64url').toString() : null
}

describe('whatever a slot holds', () => {
  const fragments = [
    'kurumi:',
    'KURUMI:',
    'sk-ant-kurumi-',
    'YW50aHJvcGljL2E',
    'google/a',
    'google/Acme',
    'notion/b',
    'Acme',
    'Inc.',
    ', ',
    ',',
    ' ',
    '%2C',
    '%20',
    '%3A',
    '%2F',
    '%E0',
    '%',
    'Bearer ',
    'token ',
    'Basic ',
    'placeholder',
    'x:',
    ':',
    '"',
    '*',
    '=',
    'ya29.',
    '%6Burumi:',
    '%6burumi',
    'a3VydW1p',
    '.',
  ]
  const candidates = [
    'google/a',
    'google/Acme',
    'google/Acme, Inc.',
    'notion/b',
    'anthropic/a',
    'google/kurumi-x',
  ].map((h, i) => grant(h as AccountHandle, { isDefault: i === 0 }))
  const slots: [string, CredentialSlot, (text: string) => string][] = [
    ['bearer', { kind: 'bearer' }, (text) => `Bearer ${text}`],
    ['basic', { kind: 'basic' }, (text) => basic('x', text)],
    ['header', { kind: 'header', header: 'x-api-key' }, (text) => text],
  ]

  function* texts(count: number): Generator<string> {
    let seed = 20260101
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!
    const leads = ['kurumi:', 'KURUMI:', 'sk-ant-kurumi-']
    const handles = [
      'google/a',
      'google/Acme',
      'notion/b',
      'google/Acme, Inc.',
      'anthropic/a',
      'google/kurumi-x',
    ]
    for (let i = 0; i < count; i++) {
      const random = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(fragments))
      yield next() < 0.3
        ? pick(leads) + pick(handles) + (next() < 0.3 ? pick(fragments) : '')
        : (next() < 0.5 ? pick(leads) : '') + random.join('')
    }
  }

  test.each(slots)(
    'the %s slot never names an account the text does not name alone',
    (_name, slot, place) => {
      let namedCount = 0
      for (const text of texts(1200)) {
        const { selector } = readSelector(
          defaultSelectorShape,
          slot,
          request({ headers: { [headerOf(slot)]: place(text) } }),
        )
        const selection = selectAccount('gmail', candidates, selector)

        if (!mentions(text)) {
          if (!text.includes('a3VydW1p'))
            expect(selection).toMatchObject({ ok: true, how: 'default' })
          continue
        }
        if (!selection.ok) continue
        expect(selection.how).toBe('named')
        namedCount++
        expect(text.replace(/%6b/gi, 'k').match(/kurumi/gi)).toHaveLength(1)
        expect(text).not.toContain('a3VydW1p')
        expect<string>(selection.handle).toBe(
          handleThatTextNames(slot.kind === 'basic' ? text : text.trim())!,
        )
      }
      expect(namedCount).toBeGreaterThan(50)
    },
  )
})
