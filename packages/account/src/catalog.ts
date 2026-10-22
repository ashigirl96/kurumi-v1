export type CredentialSlot =
  | { kind: 'bearer' }
  | { kind: 'header'; header: string }
  | { kind: 'basic' }
  | { kind: 'query'; param: string }

export type HostRule = {
  host: string
  pathPrefix?: string
}

export type ServiceSpec = {
  displayName: string
  hosts: readonly HostRule[]
  slot: CredentialSlot
  scopes: readonly string[]
  containerEnv?: (selector: string) => Readonly<Record<string, string>>
}

export type OAuthSpec = {
  authorizeUrl: string
  tokenUrl: string
  authorizeParams?: Readonly<Record<string, string>>
  pkce: boolean
}

/**
 * `parse` returns null for a slot value that carries no selector (the SDK's own placeholder). A value that carries
 * the vendor's prefix but is malformed is returned whole: it names no granted account, so the caller refuses it
 * instead of falling back to the default.
 */
export type SelectorShape = {
  format: (handle: string) => string
  parse: (slotValue: string) => string | null
}

const decodeIfEncoded = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const defaultPrefix = /^kurumi:/i

/**
 * Percent-encoded because an HTTP header value cannot carry non-Latin1 characters and a query value cannot carry
 * `&`, `#` or `+`. `/`, `@` and `:` stay readable.
 */
export const defaultSelectorShape: SelectorShape = {
  format: (handle) =>
    `kurumi:${encodeURIComponent(handle.toWellFormed()).replaceAll('%2F', '/').replaceAll('%40', '@').replaceAll('%3A', ':')}`,
  parse: (slotValue) =>
    defaultPrefix.test(slotValue) ? decodeIfEncoded(slotValue.slice('kurumi:'.length)) : null,
}

const anthropicPrefix = 'sk-ant-kurumi-'

export type VendorSpec = {
  displayName: string
  connect: { kind: 'oauth'; oauth: OAuthSpec } | { kind: 'key' }
  services: Readonly<Record<string, ServiceSpec>>
  selectorShape?: SelectorShape
}

export const catalog = {
  anthropic: {
    displayName: 'Anthropic',
    connect: { kind: 'key' },
    selectorShape: {
      format: (handle) => `${anthropicPrefix}${Buffer.from(handle).toString('base64url')}`,
      parse: (value) => {
        if (!value.startsWith(anthropicPrefix)) return null
        const payload = value.slice(anthropicPrefix.length)
        const decoded = Buffer.from(payload, 'base64url').toString()
        return decoded !== '' && Buffer.from(decoded).toString('base64url') === payload
          ? decoded
          : value
      },
    },
    services: {
      'anthropic-api': {
        displayName: 'Anthropic API',
        hosts: [{ host: 'api.anthropic.com' }],
        slot: { kind: 'header', header: 'x-api-key' },
        scopes: [],
        containerEnv: (selector) => ({ ANTHROPIC_API_KEY: selector }),
      },
    },
  },
  google: {
    displayName: 'Google',
    connect: {
      kind: 'oauth',
      oauth: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        // Google issues a refresh token only on first consent unless prompt=consent.
        authorizeParams: {
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'true',
        },
        pkce: true,
      },
    },
    services: {
      gmail: {
        displayName: 'Gmail',
        hosts: [
          { host: 'gmail.googleapis.com' },
          { host: 'www.googleapis.com', pathPrefix: '/gmail/' },
          { host: 'www.googleapis.com', pathPrefix: '/upload/gmail/' },
          { host: 'www.googleapis.com', pathPrefix: '/resumable/upload/gmail/' },
          { host: 'www.googleapis.com', pathPrefix: '/batch/gmail/' },
        ],
        slot: { kind: 'bearer' },
        scopes: ['https://mail.google.com/'],
      },
      'google-calendar': {
        displayName: 'Google Calendar',
        hosts: [
          { host: 'www.googleapis.com', pathPrefix: '/calendar/' },
          { host: 'www.googleapis.com', pathPrefix: '/batch/calendar/' },
        ],
        slot: { kind: 'bearer' },
        scopes: ['https://www.googleapis.com/auth/calendar'],
      },
    },
  },
  notion: {
    displayName: 'Notion',
    connect: {
      kind: 'oauth',
      oauth: {
        authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
        tokenUrl: 'https://api.notion.com/v1/oauth/token',
        authorizeParams: { owner: 'user' },
        pkce: false,
      },
    },
    services: {
      notion: {
        displayName: 'Notion',
        hosts: [{ host: 'api.notion.com' }],
        slot: { kind: 'bearer' },
        scopes: [],
      },
    },
  },
  github: {
    displayName: 'GitHub',
    connect: { kind: 'key' },
    services: {
      github: {
        displayName: 'GitHub',
        hosts: [{ host: 'api.github.com' }, { host: 'github.com' }],
        slot: { kind: 'basic' },
        scopes: [],
      },
    },
  },
} as const satisfies Record<string, VendorSpec>

type Catalog = typeof catalog
export type VendorId = keyof Catalog
/** Service ids are unique across vendors (a test walks the catalog), so a service alone names its vendor. */
export type ServiceId = { [V in VendorId]: keyof Catalog[V]['services'] }[VendorId]

type ServiceRow = { vendor: VendorId; service: ServiceId; spec: ServiceSpec }

const vendors: Readonly<Record<string, VendorSpec>> = catalog

const serviceRows: readonly ServiceRow[] = Object.entries(vendors).flatMap(([vendor, vendorSpec]) =>
  Object.entries(vendorSpec.services).map(([service, spec]) => ({
    vendor: vendor as VendorId,
    service: service as ServiceId,
    spec,
  })),
)

const rowOf = Object.fromEntries(serviceRows.map((row) => [row.service, row])) as Record<
  ServiceId,
  ServiceRow
>

export const vendorIds = Object.keys(catalog) as [VendorId, ...VendorId[]]
export const serviceIds = serviceRows.map(({ service }) => service) as [ServiceId, ...ServiceId[]]

export function vendorOf(service: ServiceId): VendorId {
  return rowOf[service].vendor
}

export function serviceSpec(service: ServiceId): ServiceSpec {
  return rowOf[service].spec
}

export function selectorShapeOf(vendor: VendorId): SelectorShape {
  const spec: VendorSpec = catalog[vendor]
  return spec.selectorShape ?? defaultSelectorShape
}

const unreserved = /[A-Za-z0-9\-._~]/

/**
 * The path as the upstream would route it, or null when that is in doubt. Google decodes unreserved `%XX` escapes
 * and answers a dot segment with a redirect, so a path that still has one (or an escaped slash, a backslash or a
 * `;`) could name a different service than its prefix suggests.
 */
function routablePath(rawPath: string): string | null {
  const end = rawPath.search(/[?#]/)
  const path = end === -1 ? rawPath : rawPath.slice(0, end)
  const rooted = path.startsWith('/') ? path : `/${path}`
  if (/[\\;]|%2f|%5c/i.test(rooted)) return null
  const decoded = rooted.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16))
    return unreserved.test(char) ? char : escape
  })
  return /\/\.{1,2}(?:\/|$)/.test(decoded) ? null : decoded
}

/** Hostnames are compared lowercase without the trailing dot. A port is not part of a hostname. */
export const normalizeHost = (host: string): string => host.toLowerCase().replace(/\.$/, '')

type Located<V extends string, S extends string> = Readonly<{ vendor: V; service: S }>

export function createServiceFinder<V extends string, S extends string>(
  entries: readonly { vendor: V; service: S; hosts: readonly HostRule[] }[],
): (host: string, path: string) => Located<V, S> | null {
  const rulesByHost = new Map<string, { prefix: string; located: Located<V, S> }[]>()
  for (const { vendor, service, hosts } of entries) {
    for (const { host, pathPrefix } of hosts) {
      const rules = rulesByHost.get(host) ?? []
      rules.push({ prefix: pathPrefix ?? '', located: { vendor, service } })
      rulesByHost.set(host, rules)
    }
  }
  for (const rules of rulesByHost.values()) rules.sort((a, b) => b.prefix.length - a.prefix.length)

  return (host, path) => {
    const rules = rulesByHost.get(normalizeHost(host))
    if (!rules) return null
    const routed = routablePath(path)
    if (routed === null) return null
    return rules.find(({ prefix }) => routed.startsWith(prefix))?.located ?? null
  }
}

export const serviceFor: (host: string, path: string) => Located<VendorId, ServiceId> | null =
  createServiceFinder(
    serviceRows.map(({ vendor, service, spec }) => ({ vendor, service, hosts: spec.hosts })),
  )

const intercepted: ReadonlySet<string> = new Set(
  serviceRows.flatMap(({ spec }) => spec.hosts.map(({ host }) => host)),
)

/** Hosts the gateway must MITM (every service host). Everything else is tunnelled untouched. */
export function interceptedHosts(): ReadonlySet<string> {
  return intercepted
}

export const isInterceptedHost = (host: string): boolean => intercepted.has(normalizeHost(host))

export function scopesFor(services: readonly ServiceId[]): string[] {
  return [...new Set(services.flatMap((service) => serviceSpec(service).scopes))]
}

export function servicesCovered(vendor: VendorId, grantedScopes: readonly string[]): ServiceId[] {
  const granted = new Set(grantedScopes)
  return serviceRows
    .filter((row) => row.vendor === vendor && row.spec.scopes.every((scope) => granted.has(scope)))
    .map(({ service }) => service)
}

/** `service IN (…)` per vendor for account_grant's CHECK, generated so it is never written by hand. */
export function serviceBelongsToVendorSql(serviceColumn: string, vendorColumn: string): string {
  const perVendor = Object.entries(vendors).map(([vendor, spec]) => {
    const services = Object.keys(spec.services)
      .map((s) => `'${s}'`)
      .join(',')
    return `(${vendorColumn} = '${vendor}' AND ${serviceColumn} IN (${services}))`
  })
  return `(${perVendor.join(' OR ')})`
}
