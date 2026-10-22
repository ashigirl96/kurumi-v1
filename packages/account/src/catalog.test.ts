import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import {
  catalog,
  createServiceFinder,
  defaultSelectorShape,
  interceptedHosts,
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

  test.each([
    ['/gmail/../calendar/v3/calendars/primary', 'google-calendar'],
    ['/calendar/../gmail/v1/users/me', 'gmail'],
    ['/gmail/./v1/users/me', 'gmail'],
    ['/%63alendar/v3/calendars/primary', 'google-calendar'],
    ['/gmail/%2e%2e/calendar/v3/x', 'google-calendar'],
    ['/gmail/v1/../../calendar/v3/x?next=/gmail/', 'google-calendar'],
  ])('%s resolves to the service Google would route it to: %s', (path, service) => {
    expect(serviceFor('www.googleapis.com', path)?.service).toBe(service as never)
  })

  test.each([
    '/gmail/../drive/v3/files',
    '/gmail/../../etc',
    '/%2fgmail/v1',
    '//calendar/v3',
    '/gmail%2Fv1/x',
  ])('%s matches no service', (path) => {
    expect(serviceFor('www.googleapis.com', path)).toBeNull()
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
  })
})

describe('interceptedHosts', () => {
  test('lists every host of every service and nothing else', () => {
    const expected = allServices.flatMap(({ service }) => service.hosts.map(({ host }) => host))

    expect([...interceptedHosts()].toSorted()).toEqual([...new Set(expected)].toSorted())
    expect(interceptedHosts().has('www.googleapis.com')).toBe(true)
    expect(interceptedHosts().has('example.com')).toBe(false)
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

      for (const value of ['', 'sk-ant-api03-realkey', 'placeholder', 'Bearer kurumi:x/y']) {
        expect(shape.parse(value)).toBeNull()
      }
    },
  )

  test('the default shape accepts a handle typed by hand', () => {
    expect(defaultSelectorShape.parse('kurumi:google/alice@work.example')).toBe(
      'google/alice@work.example',
    )
    expect(defaultSelectorShape.format('google/alice@work.example')).toBe(
      'kurumi:google/alice@work.example',
    )
  })

  test('the anthropic shape does not accept a mangled payload', () => {
    expect(selectorShapeOf('anthropic').parse('sk-ant-kurumi-***')).toBeNull()
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
