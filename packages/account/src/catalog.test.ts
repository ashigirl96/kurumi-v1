import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import {
  catalog,
  createServiceFinder,
  defaultSelectorShape,
  interceptedHosts,
  isInterceptedHost,
  scopesFor,
  selectorShapeOf,
  serviceBelongsToVendorSql,
  serviceFor,
  serviceIds,
  serviceSpec,
  servicesCovered,
  vendorIds,
  vendorOf,
  type HostRule,
  type ServiceSpec,
} from './catalog.ts'

const allServices = Object.entries(catalog).flatMap(([vendor, spec]) =>
  Object.entries(spec.services as Record<string, ServiceSpec>).map(([id, service]) => ({
    vendor,
    id,
    service,
  })),
)

describe('catalog shape', () => {
  test('a service id belongs to exactly one vendor', () => {
    const ids = allServices.map(({ id }) => id)

    expect(new Set(ids).size).toBe(ids.length)
    expect<readonly string[]>(serviceIds.toSorted()).toEqual(ids.toSorted())
    expect<readonly string[]>(vendorIds.toSorted()).toEqual(Object.keys(catalog).toSorted())
  })

  test('services that share a host are told apart by a pathPrefix on every rule', () => {
    const rulesByHost = new Map<string, { id: string; rule: HostRule }[]>()
    for (const { id, service } of allServices) {
      for (const rule of service.hosts) {
        rulesByHost.set(rule.host, [...(rulesByHost.get(rule.host) ?? []), { id, rule }])
      }
    }

    const shared = [...rulesByHost].filter(
      ([, rules]) => new Set(rules.map(({ id }) => id)).size > 1,
    )

    expect(shared.length).toBeGreaterThan(0)
    for (const [host, rules] of shared) {
      expect(rules.filter(({ rule }) => !rule.pathPrefix).map(({ id }) => `${host} ${id}`)).toEqual(
        [],
      )
    }
  })

  test('no two rules claim the same host and pathPrefix for different services', () => {
    const claimed = new Map<string, string>()
    const clashes: string[] = []
    for (const { id, service } of allServices) {
      for (const { host, pathPrefix } of service.hosts) {
        const key = `${host}${pathPrefix ?? ''}`
        const owner = claimed.get(key)
        if (owner && owner !== id) clashes.push(`${key} ${owner} ${id}`)
        claimed.set(key, id)
      }
    }

    expect(clashes).toEqual([])
  })

  test('vendorOf and serviceSpec resolve every service id of the catalog', () => {
    for (const { vendor, id, service } of allServices) {
      expect(vendorOf(id as never)).toBe(vendor as never)
      expect(serviceSpec(id as never)).toBe(service)
    }
  })
})

describe('serviceFor', () => {
  test.each([
    ['gmail.googleapis.com', '/gmail/v1/users/me/messages', 'google', 'gmail'],
    ['gmail.googleapis.com', '/upload/gmail/v1/users/me/messages/send', 'google', 'gmail'],
    ['gmail.googleapis.com', '/batch', 'google', 'gmail'],
    ['www.googleapis.com', '/gmail/v1/users/me/messages', 'google', 'gmail'],
    ['www.googleapis.com', '/upload/gmail/v1/users/me/messages/send', 'google', 'gmail'],
    ['www.googleapis.com', '/resumable/upload/gmail/v1/users/me/messages/send', 'google', 'gmail'],
    ['www.googleapis.com', '/batch/gmail/v1', 'google', 'gmail'],
    ['www.googleapis.com', '/calendar/v3/calendars/primary/events', 'google', 'google-calendar'],
    ['www.googleapis.com', '/batch/calendar/v3', 'google', 'google-calendar'],
    [
      'www.googleapis.com',
      '/calendar/v3/calendars/primary/events?alt=json',
      'google',
      'google-calendar',
    ],
    ['api.anthropic.com', '/v1/messages', 'anthropic', 'anthropic-api'],
    ['api.github.com', '/user', 'github', 'github'],
    ['github.com', '/o/r.git/info/refs', 'github', 'github'],
    ['api.notion.com', '/v1/pages', 'notion', 'notion'],
  ])('%s %s is %s/%s', (host, path, vendor, service) => {
    expect(serviceFor(host, path)).toEqual({ vendor, service } as never)
  })

  test.each([
    ['example.com', '/gmail/v1/users/me'],
    ['www.googleapis.com', '/drive/v3/files'],
    ['www.googleapis.com', '/gmailx/v1'],
    ['www.googleapis.com', '/'],
    ['www.googleapis.com', ''],
    ['googleapis.com', '/gmail/v1'],
    ['evil.gmail.googleapis.com', '/gmail/v1'],
  ])('%s %s belongs to no service', (host, path) => {
    expect(serviceFor(host, path)).toBeNull()
  })

  test('the host is matched without regard to case and a trailing dot', () => {
    expect(serviceFor('Gmail.GoogleAPIs.com.', '/x')?.service).toBe('gmail')
  })

  test('a path without a leading slash is read as rooted', () => {
    expect(serviceFor('www.googleapis.com', 'calendar/v3/users/me/calendarList')?.service).toBe(
      'google-calendar',
    )
  })

  test('an unreserved character written as a %XX escape is read as the character', () => {
    expect(serviceFor('www.googleapis.com', '/%63alendar/v3/calendars/primary')?.service).toBe(
      'google-calendar',
    )
    expect(
      serviceFor('www.googleapis.com', '/calendar/v3/calendars/a%40b.example/events')?.service,
    ).toBe('google-calendar')
  })

  test.each([
    '/gmail/../calendar/v3/calendars/primary',
    '/calendar/../gmail/v1/users/me',
    '/gmail/./v1/users/me',
    '/gmail/..',
    '/gmail/%2e%2e/calendar/v3/x',
    '/gmail/.%2E/calendar/v3/x',
    '/calendar/v3/..;/../gmail/v1/users/me',
    '/gmail/..%2Fcalendar/v3/x',
    '/gmail/..%5Ccalendar/v3/x',
    '/gmail/..\\calendar/v3/x',
    '/gmail/%2fv1/x',
    '/%2fgmail/v1',
    '/gmail%2Fv1/x',
    '/gmail/v1;x=1/users',
  ])('%s is in doubt, so it belongs to no service', (path) => {
    expect(serviceFor('www.googleapis.com', path)).toBeNull()
  })

  test.each(['//calendar/v3', '//gmail/v1/users/me', '/gmail'])(
    '%s does not match a prefix and belongs to no service',
    (path) => {
      expect(serviceFor('www.googleapis.com', path)).toBeNull()
    },
  )

  test('a dot segment or an escape inside the query does not matter', () => {
    expect(
      serviceFor('www.googleapis.com', '/gmail/v1/users/me?next=/../../calendar/v3%2f')?.service,
    ).toBe('gmail')
    expect(serviceFor('www.googleapis.com', '/calendar/v3/x#/../gmail/')?.service).toBe(
      'google-calendar',
    )
  })

  describe('a host that only one service uses', () => {
    const inDoubt = [
      '/repos/o/r/branches/feature%2Fx',
      '/repos/o/r/contents/.github%2Fworkflows%2Fci.yml',
      '/repos/o/r/git/ref/heads%2Ffeature%2Fx',
      '/a/../b',
      '/a/%2e%2e/b',
      '/a%5Cb',
      '/a\\b',
      '/a;b=1',
      '/',
      '',
    ]
    const singleServiceHosts = allServices.flatMap(({ vendor, id, service }) =>
      service.hosts
        .filter(
          ({ host, pathPrefix }) =>
            pathPrefix === undefined &&
            allServices.every(
              (other) => other.id === id || other.service.hosts.every((rule) => rule.host !== host),
            ),
        )
        .map(({ host }) => [host, vendor, id] as const),
    )

    test('the catalog has such hosts', () => {
      expect(singleServiceHosts.map(([host]) => host)).toEqual(
        expect.arrayContaining([
          'api.github.com',
          'github.com',
          'api.notion.com',
          'api.anthropic.com',
          'gmail.googleapis.com',
        ]),
      )
    })

    test.each(singleServiceHosts)(
      '%s routes to its service whatever the path',
      (host, vendor, id) => {
        for (const path of inDoubt) {
          expect(serviceFor(host, path)).toEqual({ vendor, service: id } as never)
        }
      },
    )

    test('a host shared by two services still refuses a path in doubt', () => {
      expect(serviceFor('www.googleapis.com', '/gmail/v1/users/me/messages%2Fx')).toBeNull()
    })
  })

  test('a host with a port is not a hostname and belongs to no service', () => {
    expect(serviceFor('www.googleapis.com:443', '/gmail/v1/x')).toBeNull()
  })

  describe('createServiceFinder', () => {
    const entries = [
      { vendor: 'v', service: 'wide', hosts: [{ host: 'h.example', pathPrefix: '/a/' }] },
      { vendor: 'v', service: 'narrow', hosts: [{ host: 'h.example', pathPrefix: '/a/b/' }] },
      { vendor: 'v', service: 'rest', hosts: [{ host: 'h.example' }] },
    ]

    test('the longest matching pathPrefix wins whatever the catalog order', () => {
      for (const order of [entries, entries.toReversed()]) {
        const find = createServiceFinder(order)

        expect(find('h.example', '/a/b/c')?.service).toBe('narrow')
        expect(find('h.example', '/a/c')?.service).toBe('wide')
        expect(find('h.example', '/z')?.service).toBe('rest')
        expect(find('other.example', '/a/b/c')).toBeNull()
      }
    })

    test('a host with one service and no prefix takes every path, a prefixed one only its own', () => {
      const find = createServiceFinder([
        { vendor: 'v', service: 'whole', hosts: [{ host: 'whole.example' }] },
        { vendor: 'v', service: 'part', hosts: [{ host: 'part.example', pathPrefix: '/p/' }] },
        {
          vendor: 'v',
          service: 'both',
          hosts: [{ host: 'both.example' }, { host: 'both.example', pathPrefix: '/p/' }],
        },
      ])

      expect(find('whole.example', '/x%2Fy/../z')?.service).toBe('whole')
      expect(find('both.example', '/x%2Fy/../z')?.service).toBe('both')
      expect(find('part.example', '/p/x')?.service).toBe('part')
      expect(find('part.example', '/p/x%2Fy')).toBeNull()
      expect(find('part.example', '/other')).toBeNull()
    })
  })
})

describe('interceptedHosts', () => {
  test('lists every host of every service and nothing else', () => {
    const expected = allServices.flatMap(({ service }) => service.hosts.map(({ host }) => host))

    expect([...interceptedHosts()].toSorted()).toEqual([...new Set(expected)].toSorted())
    expect(interceptedHosts().has('www.googleapis.com')).toBe(true)
    expect(interceptedHosts().has('example.com')).toBe(false)
  })

  test('isInterceptedHost compares a hostname the way serviceFor does', () => {
    expect(isInterceptedHost('WWW.googleapis.com.')).toBe(true)
    expect(isInterceptedHost('api.github.com')).toBe(true)
    expect(isInterceptedHost('www.googleapis.com:443')).toBe(false)
    expect(isInterceptedHost('example.com')).toBe(false)
    for (const host of interceptedHosts()) {
      expect(isInterceptedHost(host)).toBe(true)
    }
  })
})

describe('scopes', () => {
  test('scopesFor is the deduplicated union over the services', () => {
    expect(scopesFor(['gmail'])).toEqual(['https://mail.google.com/'])
    expect(scopesFor(['gmail', 'google-calendar'])).toEqual([
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar',
    ])
    expect(scopesFor(['gmail', 'gmail'])).toEqual(['https://mail.google.com/'])
    expect(scopesFor([])).toEqual([])
    expect(scopesFor(['notion'])).toEqual([])
  })

  const mail = 'https://mail.google.com/'
  const calendar = 'https://www.googleapis.com/auth/calendar'

  test('servicesCovered returns only the services whose every scope was granted', () => {
    expect(servicesCovered('google', [mail])).toEqual(['gmail'])
    expect(servicesCovered('google', [calendar])).toEqual(['google-calendar'])
    expect(servicesCovered('google', [calendar, mail])).toEqual(['gmail', 'google-calendar'])
    expect(servicesCovered('google', [])).toEqual([])
  })

  test('a narrower or unrelated scope covers no service', () => {
    const narrower = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://mail.google.com',
      'openid',
    ]

    for (const scope of narrower) expect(servicesCovered('google', [scope])).toEqual([])
    expect(servicesCovered('google', narrower)).toEqual([])
  })

  test('a service that needs no scope is covered by any grant of its vendor', () => {
    expect(servicesCovered('notion', [])).toEqual(['notion'])
    expect(servicesCovered('github', [mail])).toEqual(['github'])
  })
})

describe('selectorShapeOf', () => {
  test('a vendor without its own shape gets the default', () => {
    expect(selectorShapeOf('google')).toBe(defaultSelectorShape)
  })

  test('the anthropic shape keeps the sk-ant- prefix an SDK may check', () => {
    expect(selectorShapeOf('anthropic').format('anthropic/team')).toStartWith('sk-ant-')
  })

  const handles = [
    'google/alice@work.example',
    'google/a+tag@x.example',
    'notion/ノート 共有',
    'notion/a b',
    'github/100%',
    'github/%41',
    'google/😀@x.example',
    'github/a:b/c',
    'notion/a&b#c=d?e',
  ]

  test.each(vendorIds)('%s selector shape round-trips awkward handles', (vendor) => {
    const shape = selectorShapeOf(vendor)

    for (const handle of handles) expect(shape.parse(shape.format(handle))).toBe(handle)
  })

  test.each(vendorIds)(
    '%s selector shape produces a value that can ride an HTTP header',
    (vendor) => {
      const shape = selectorShapeOf(vendor)

      for (const handle of handles) {
        const headers = new Headers({ authorization: `Bearer ${shape.format(handle)}` })
        expect(headers.get('authorization')).toBe(`Bearer ${shape.format(handle)}`)
      }
    },
  )

  test.each(vendorIds)(
    '%s selector shape reads a value that is not a selector as none',
    (vendor) => {
      const shape = selectorShapeOf(vendor)

      for (const value of [
        '',
        'sk-ant-api03-realkey',
        'placeholder',
        'Bearer kurumi:x/y',
        'ya29.token',
      ]) {
        expect(shape.parse(value)).toBeNull()
      }
    },
  )

  test.each(vendorIds)('%s selector shape reads the default form as well as its own', (vendor) => {
    const shape = selectorShapeOf(vendor)

    expect(shape.parse('kurumi:anthropic/b')).toBe('anthropic/b')
    expect(shape.parse(shape.format('anthropic/b'))).toBe('anthropic/b')
  })

  test.each(vendorIds)('%s selector shape refuses a look-alike of either form', (vendor) => {
    const shape = selectorShapeOf(vendor)

    for (const value of ['sk-ant-kurumi-***', 'SK-ANT-KURUMI-YQ==', 'sk-ant-kurumi-']) {
      expect(shape.parse(value)).toBe(value)
    }
  })

  test('the default shape accepts a handle typed by hand', () => {
    expect(defaultSelectorShape.parse('kurumi:google/alice@work.example')).toBe(
      'google/alice@work.example',
    )
    expect(defaultSelectorShape.format('google/alice@work.example')).toBe(
      'kurumi:google/alice@work.example',
    )
  })

  test('the default prefix is read without regard to case', () => {
    expect(defaultSelectorShape.parse('Kurumi:google/alice@work.example')).toBe(
      'google/alice@work.example',
    )
  })

  test.each([
    'sk-ant-kurumi-***',
    'sk-ant-kurumi-',
    'sk-ant-kurumi-A',
    'sk-ant-kurumi-YQ==',
    'sk-ant-kurumi-YR',
    'sk-ant-kurumi-anthropic/team',
  ])(
    'a value %p with the anthropic prefix but a malformed payload is returned whole, never none',
    (value) => {
      expect(selectorShapeOf('anthropic').parse(value)).toBe(value)
    },
  )

  test('format output stays readable for the characters a handle is made of', () => {
    expect(defaultSelectorShape.format('google/alice@work.example')).toBe(
      'kurumi:google/alice@work.example',
    )
    expect(defaultSelectorShape.format('github/a b&c#d+e=f')).toBe(
      'kurumi:github/a%20b%26c%23d%2Be%3Df',
    )
  })

  test('format survives a label with a lone surrogate', () => {
    expect(() => defaultSelectorShape.format('notion/a\ud800b')).not.toThrow()
  })
})

const grantTable = () => {
  const db = new Database(':memory:')
  db.run(
    `CREATE TABLE account_grant (vendor TEXT NOT NULL, service TEXT NOT NULL, CHECK (${serviceBelongsToVendorSql('service', 'vendor')}))`,
  )
  return db
}

describe('serviceBelongsToVendorSql', () => {
  test('accepts every service of its own vendor', () => {
    const db = grantTable()

    for (const { vendor, id } of allServices) {
      expect(() => db.run('INSERT INTO account_grant VALUES (?, ?)', [vendor, id])).not.toThrow()
    }
  })

  test('can be combined with another condition without changing its meaning', () => {
    const db = new Database(':memory:')
    db.run(
      `CREATE TABLE t (flag INTEGER NOT NULL, vendor TEXT NOT NULL, service TEXT NOT NULL, CHECK (flag = 1 AND ${serviceBelongsToVendorSql('service', 'vendor')}))`,
    )

    expect(() => db.run('INSERT INTO t VALUES (1, ?, ?)', ['google', 'gmail'])).not.toThrow()
    expect(() => db.run('INSERT INTO t VALUES (0, ?, ?)', ['google', 'gmail'])).toThrow(/CHECK/)
  })

  test('the ids it writes into SQL are plain words', () => {
    for (const id of [...vendorIds, ...serviceIds]) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  test('rejects a service of another vendor and an unknown service', () => {
    const db = grantTable()

    for (const [vendor, service] of [
      ['google', 'notion'],
      ['anthropic', 'gmail'],
      ['github', 'google-calendar'],
      ['google', 'unknown'],
      ['unknown', 'gmail'],
    ] as const) {
      expect(() => db.run('INSERT INTO account_grant VALUES (?, ?)', [vendor, service])).toThrow(
        /CHECK/,
      )
    }
  })
})
