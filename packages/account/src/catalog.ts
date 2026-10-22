// The only list of vendors and services kurumi knows. A vendor issues identities (Google, Notion, Anthropic);
// a service is one API such an identity can call (Gmail, Calendar). Adding a service is one entry here.

export type CredentialSlot =
  | { kind: 'bearer' } // `Authorization: Bearer <secret>`
  | { kind: 'header'; header: string } // `x-api-key: <secret>`
  | { kind: 'basic' } // `Authorization: Basic base64(user:<secret>)` (git over https)
  | { kind: 'query'; param: string } // `?key=<secret>`

export type HostRule = {
  host: string
  /** Separates services that share a host (www.googleapis.com/gmail/… vs /calendar/…). */
  pathPrefix?: string
}

export type ServiceSpec = {
  displayName: string
  hosts: readonly HostRule[]
  slot: CredentialSlot
  /** OAuth scopes this service needs. One consent may request the union over several services. */
  scopes: readonly string[]
  /** Env placeholders the container gets when its group holds this service (value = the selector). */
  containerEnv?: (selector: string) => Readonly<Record<string, string>>
}

export type OAuthSpec = {
  authorizeUrl: string
  tokenUrl: string
  /**
   * Google: access_type=offline + prompt=consent (Google returns a refresh token only on the first authorization
   * otherwise). With `include_granted_scopes=true` the refresh token represents the combined authorization, so
   * adding a service keeps the earlier scopes.
   */
  authorizeParams?: Readonly<Record<string, string>>
  pkce: boolean
}

/**
 * How the agent writes an Account Handle into the credential slot. A vendor whose SDK validates the credential's
 * shape before sending (a `sk-ant-` prefix check) overrides the default. `parse` returns the handle, or null when
 * the slot holds no selector (the SDK's own placeholder).
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

const defaultPrefix = 'kurumi:'

/** The label is percent-encoded because an HTTP header value cannot carry non-Latin1 characters. */
export const defaultSelectorShape: SelectorShape = {
  format: (handle) => `${defaultPrefix}${encodeURI(handle)}`,
  parse: (slotValue) =>
    slotValue.startsWith(defaultPrefix)
      ? decodeIfEncoded(slotValue.slice(defaultPrefix.length))
      : null,
}

const anthropicPrefix = 'sk-ant-kurumi-'
const base64url = /^[A-Za-z0-9_-]+$/

export type VendorSpec = {
  displayName: string
  /** `key` vendors are added by a human via CLI/Console only. */
  connect: { kind: 'oauth'; oauth: OAuthSpec } | { kind: 'key' }
  services: Readonly<Record<string, ServiceSpec>>
  selectorShape?: SelectorShape
}

export const catalog = {
  anthropic: {
    displayName: 'Anthropic',
    connect: { kind: 'key' },
    // Whether the Agent SDK / Claude Code rejects a key without the `sk-ant-` prefix is unverified.
    selectorShape: {
      format: (handle) => `${anthropicPrefix}${Buffer.from(handle).toString('base64url')}`,
      parse: (value) => {
        const payload = value.slice(anthropicPrefix.length)
        return value.startsWith(anthropicPrefix) && base64url.test(payload)
          ? Buffer.from(payload, 'base64url').toString()
          : null
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
  return (catalog[vendor] as VendorSpec).selectorShape ?? defaultSelectorShape
}

const unreserved = /[A-Za-z0-9\-._~]/

function resolveDotSegments(path: string): string {
  const kept: string[] = []
  const segments = path.split('/').slice(1)
  segments.forEach((segment, i) => {
    if (segment !== '.' && segment !== '..') {
      kept.push(segment)
      return
    }
    if (segment === '..') kept.pop()
    if (i === segments.length - 1) kept.push('')
  })
  return `/${kept.join('/')}`
}

/**
 * The path the upstream will route: Google resolves dot segments and percent-escaped unreserved characters, so
 * `/gmail/../calendar/` must not be taken for Gmail. An escape that is not unreserved (`%2F`) stays as it is and
 * matches no prefix.
 */
function routedPath(rawPath: string): string {
  const end = rawPath.search(/[?#]/)
  const path = end === -1 ? rawPath : rawPath.slice(0, end)
  const rooted = path.startsWith('/') ? path : `/${path}`
  if (!rooted.includes('%') && !rooted.includes('/.')) return rooted
  const decoded = rooted.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16))
    return unreserved.test(char) ? char : escape
  })
  return resolveDotSegments(decoded)
}

type Located<V extends string, S extends string> = Readonly<{ vendor: V; service: S }>

/** Builds the lookup behind `serviceFor`: longest pathPrefix first within a host. */
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
    const rules = rulesByHost.get(host.toLowerCase().replace(/\.$/, ''))
    if (!rules) return null
    const routed = routedPath(path)
    return rules.find(({ prefix }) => routed.startsWith(prefix))?.located ?? null
  }
}

/**
 * Host + path → the one service whose rule matches. Services sharing a host are always separated by pathPrefix
 * (checked by a test over `catalog`), so the answer is never ambiguous.
 */
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

/** Union of scopes for one consent over several services of one vendor. */
export function scopesFor(services: readonly ServiceId[]): string[] {
  return [...new Set(services.flatMap((service) => serviceSpec(service).scopes))]
}

/** Services of `vendor` whose scopes are all inside `grantedScopes`. Becomes `account.services`. */
export function servicesCovered(vendor: VendorId, grantedScopes: readonly string[]): ServiceId[] {
  const granted = new Set(grantedScopes)
  return serviceRows
    .filter((row) => row.vendor === vendor && row.spec.scopes.every((scope) => granted.has(scope)))
    .map(({ service }) => service)
}

/** `service IN (…)` per vendor, generated from the catalog for account_grant's CHECK. Never written by hand. */
export function serviceBelongsToVendorSql(serviceColumn: string, vendorColumn: string): string {
  return Object.entries(vendors)
    .map(([vendor, spec]) => {
      const services = Object.keys(spec.services)
        .map((s) => `'${s}'`)
        .join(',')
      return `(${vendorColumn} = '${vendor}' AND ${serviceColumn} IN (${services}))`
    })
    .join(' OR ')
}
