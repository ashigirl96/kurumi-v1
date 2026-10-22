import { describe, expect, test } from 'bun:test'

import {
  defaultSelectorShape,
  selectorShapeOf,
  vendorIds,
  type CredentialSlot,
  type ServiceId,
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

    for (const named_ of [
      'google/a',
      'google/a@work.example ',
      'google/@work.example',
      'a@work.example',
    ]) {
      expect(selectAccount('gmail', candidates, named(named_))).toMatchObject({
        ok: false,
        refusal: { code: 'account_not_granted', named: named_ },
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
  const selectors = [none, named(handleA), named(handleC), named('google/unknown@x.example')]

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

const request = (init: { headers?: Record<string, string>; url?: string }) => ({
  headers: new Headers(init.headers),
  url: new URL(init.url ?? 'https://www.googleapis.com/gmail/v1/users/me/messages'),
})
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

describe('a selector that is malformed but clearly meant', () => {
  const anthropic = selectorShapeOf('anthropic')
  const handle = accountHandle('anthropic', 'team')
  const candidates = [
    grant(accountHandle('anthropic', 'personal'), { isDefault: true }),
    grant(handle),
  ]

  test.each(['sk-ant-kurumi-YW50aHJvcGljL3RlYW0=', 'sk-ant-kurumi-***'])(
    'the value %s is refused instead of falling back to the default account',
    (apiKey) => {
      const { selector } = readSelector(
        anthropic,
        { kind: 'header', header: 'x-api-key' },
        request({ headers: { 'x-api-key': apiKey } }),
      )

      expect(selectAccount('anthropic-api', candidates, selector)).toMatchObject({
        ok: false,
        refusal: { code: 'account_not_granted' },
      })
    },
  )

  test('the SDK placeholder still falls back to the default account', () => {
    const { selector } = readSelector(
      anthropic,
      { kind: 'header', header: 'x-api-key' },
      request({ headers: { 'x-api-key': 'sk-ant-api03-placeholder' } }),
    )

    expect(selectAccount('anthropic-api', candidates, selector)).toMatchObject({
      ok: true,
      how: 'default',
    })
  })
})

describe('readSelector', () => {
  const handle = 'google/alice@work.example'

  describe('bearer', () => {
    const slot: CredentialSlot = { kind: 'bearer' }

    test('reads the handle and removes the authorization header', () => {
      const req = request({
        headers: { Authorization: `Bearer kurumi:${handle}`, accept: 'application/json' },
      })

      const { selector, stripped } = readSelector(defaultSelectorShape, slot, req)

      expect(selector).toEqual(named(handle))
      expect(stripped.headers.has('authorization')).toBe(false)
      expect(stripped.headers.get('accept')).toBe('application/json')
      expect(stripped.url.href).toBe(req.url.href)
    })

    test('treats the scheme case-insensitively', () => {
      const { selector } = readSelector(
        defaultSelectorShape,
        slot,
        request({ headers: { authorization: `bearer kurumi:${handle}` } }),
      )

      expect(selector).toEqual(named(handle))
    })

    test('a token that is not a selector is none, and the slot is still emptied', () => {
      const req = request({ headers: { authorization: 'Bearer ya29.sdk-placeholder' } })

      const { selector, stripped } = readSelector(defaultSelectorShape, slot, req)

      expect(selector).toEqual(none)
      expect(stripped.headers.has('authorization')).toBe(false)
    })

    test('no authorization header is none', () => {
      const { selector, stripped } = readSelector(defaultSelectorShape, slot, request({}))

      expect(selector).toEqual(none)
      expect(stripped.headers.has('authorization')).toBe(false)
    })

    test.each([
      ['token', `token kurumi:${handle}`],
      ['Basic', basic('x', `kurumi:${handle}`)],
    ])('the %s scheme names the account too', (_scheme, authorization) => {
      const { selector, stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({ headers: { authorization } }),
      )

      expect(selector).toEqual(named(handle))
      expect(stripped.headers.has('authorization')).toBe(false)
    })

    test('a scheme that carries no secret is none and is removed', () => {
      const { selector, stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({ headers: { authorization: 'Digest username="x"' } }),
      )

      expect(selector).toEqual(none)
      expect(stripped.headers.has('authorization')).toBe(false)
    })
  })

  describe('header', () => {
    const slot: CredentialSlot = { kind: 'header', header: 'x-api-key' }
    const shape = selectorShapeOf('anthropic')

    test('reads the handle from the anthropic-shaped value and removes only that header', () => {
      const req = request({
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'X-Api-Key': shape.format('anthropic/team'), authorization: 'Bearer untouched' },
      })

      const { selector, stripped } = readSelector(shape, slot, req)

      expect(selector).toEqual(named('anthropic/team'))
      expect(stripped.headers.has('x-api-key')).toBe(false)
      expect(stripped.headers.get('authorization')).toBe('Bearer untouched')
    })

    test('the SDK placeholder is none and the header is removed', () => {
      const { selector, stripped } = readSelector(
        shape,
        slot,
        request({ headers: { 'x-api-key': 'sk-ant-placeholder' } }),
      )

      expect(selector).toEqual(none)
      expect(stripped.headers.has('x-api-key')).toBe(false)
    })
  })

  describe('basic', () => {
    const slot: CredentialSlot = { kind: 'basic' }

    test('reads the handle from the password whatever the user name is', () => {
      const req = request({
        url: 'https://github.com/o/r.git/info/refs',
        headers: { authorization: basic('x-access-token', 'kurumi:github/bot') },
      })

      const { selector, stripped } = readSelector(defaultSelectorShape, slot, req)

      expect(selector).toEqual(named('github/bot'))
      expect(stripped.headers.has('authorization')).toBe(false)
    })

    test.each(['Bearer', 'token'])(
      'the %s scheme of gh and Octokit names the account too',
      (scheme) => {
        const { selector } = readSelector(
          defaultSelectorShape,
          slot,
          request({ headers: { authorization: `${scheme} kurumi:github/bot` } }),
        )

        expect(selector).toEqual(named('github/bot'))
      },
    )

    test('a password that holds a colon keeps everything after the first colon', () => {
      const { selector } = readSelector(
        defaultSelectorShape,
        slot,
        request({ headers: { authorization: basic('x', 'kurumi:github/a:b') } }),
      )

      expect(selector).toEqual(named('github/a:b'))
    })

    test.each(['Basic', 'Basic !!!', `Basic ${Buffer.from('no-colon').toString('base64')}`])(
      'a malformed credential %p is none and is removed',
      (authorization) => {
        const { selector, stripped } = readSelector(
          defaultSelectorShape,
          slot,
          request({ headers: { authorization } }),
        )

        expect(selector).toEqual(none)
        expect(stripped.headers.has('authorization')).toBe(false)
      },
    )
  })

  describe('query', () => {
    const slot: CredentialSlot = { kind: 'query', param: 'key' }

    test('reads the handle and removes only the key parameter, leaving the rest as written', () => {
      const req = request({
        url: 'https://example.googleapis.com/x?q=a%20b&key=kurumi%3Agoogle%2Fa%40x.example&alt=json#top',
      })

      const { selector, stripped } = readSelector(defaultSelectorShape, slot, req)

      expect(selector).toEqual(named('google/a@x.example'))
      expect(stripped.url.href).toBe('https://example.googleapis.com/x?q=a%20b&alt=json#top')
    })

    test('a url whose only parameter is the key loses its query entirely', () => {
      const { stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({ url: 'https://example.googleapis.com/x?key=kurumi:google/a@x.example' }),
      )

      expect(stripped.url.href).toBe('https://example.googleapis.com/x')
    })

    test('a parameter that merely contains the name stays', () => {
      const { selector, stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({ url: 'https://example.googleapis.com/x?apikey=1&key2=2&Key=3' }),
      )

      expect(selector).toEqual(none)
      expect(stripped.url.search).toBe('?apikey=1&key2=2&Key=3')
    })

    test('a repeated key parameter is all removed and the first one names the account', () => {
      const { selector, stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({
          url: 'https://example.googleapis.com/x?key=kurumi:google/a@x&k=1&key=kurumi:google/b@x',
        }),
      )

      expect(selector).toEqual(named('google/a@x'))
      expect(stripped.url.search).toBe('?k=1')
    })

    test('no key parameter is none and leaves the url alone', () => {
      const { selector, stripped } = readSelector(
        defaultSelectorShape,
        slot,
        request({ url: 'https://h.example/x?a=1' }),
      )

      expect(selector).toEqual(none)
      expect(stripped.url.href).toBe('https://h.example/x?a=1')
    })

    test('an encoded plus in the handle survives', () => {
      const { selector } = readSelector(
        defaultSelectorShape,
        slot,
        request({ url: 'https://h.example/x?key=kurumi%3Agoogle%2Fa%2Btag%40x.example' }),
      )

      expect(selector).toEqual(named('google/a+tag@x.example'))
    })
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

  describe('awkward handles through every slot', () => {
    const handles = [
      'notion/ノート 共有',
      'google/a+tag@x.example',
      'github/a b',
      'google/日本語+ @x.example',
      'github/100%',
    ]
    const slots: [
      string,
      CredentialSlot,
      (value: string) => { headers?: Record<string, string>; url?: string },
    ][] = [
      [
        'bearer',
        { kind: 'bearer' },
        (value) => ({ headers: { authorization: `Bearer ${value}` } }),
      ],
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

    test.each(['google/a&b@x.example', 'google/a+b@x.example', 'notion/a#b=c d', 'github/a;b'])(
      'the selector %s can be pasted into the query slot as it is',
      (label) => {
        const raw = `https://h.example/x?alt=json&key=${defaultSelectorShape.format(label)}&q=1`

        const { selector, stripped } = readSelector(
          defaultSelectorShape,
          { kind: 'query', param: 'key' },
          request({ url: raw }),
        )

        expect(selector).toEqual(named(label))
        expect(stripped.url.href).toBe('https://h.example/x?alt=json&q=1')
      },
    )

    describe.each(vendorIds)('%s shape', (vendor) => {
      const shape = selectorShapeOf(vendor)

      test.each(slots)('%s slot', (_name, slot, place) => {
        for (const awkward of handles) {
          const { selector } = readSelector(shape, slot, request(place(shape.format(awkward))))

          expect(selector).toEqual(named(awkward))
        }
      })
    })
  })
})
