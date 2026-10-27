// @kurumi/account — internal module (not an entry). The only list of vendors and services kurumi knows.
// Two levels: a vendor issues identities (Google, Notion, Anthropic); a service is one API that identity can call
// (Gmail, Calendar). Adding a service = one entry here. Host matching, OAuth scopes, the credential slot, the
// selector shape, approval summaries, the CHECK on account_grant and the agent-facing docs all derive from it.

export type CredentialSlot =
  | { kind: 'bearer' } // `Authorization: Bearer <secret>`
  | { kind: 'header'; header: string } // `x-credential: <secret>`
  | { kind: 'basic' } // `Authorization: Basic base64(user:<secret>)` (git over https)
  | { kind: 'query'; param: string } // `?key=<secret>`

export type HostRule = {
  host: string // exact host, or `*.example.com`
  /** Path prefix that separates services sharing a host (www.googleapis.com/gmail/… vs /calendar/…). */
  pathPrefix?: string
}

export type ApprovalSummary = { action: string; details: { label: string; value: string }[] }

export type ServiceSpec = {
  displayName: string
  hosts: readonly HostRule[]
  slot: CredentialSlot
  /** OAuth scopes this service needs. One consent may request the union over several services. */
  scopes: readonly string[]
  /** Optional request summarizer for approval cards (Gmail send, Calendar insert…). */
  summarize?: (req: { method: string; path: string; bodyPreview: Uint8Array }) => ApprovalSummary | null
  /** Env placeholders the container gets when its group holds this service (value = the selector). */
  containerEnv?: (selector: string) => Readonly<Record<string, string>>
}

export type OAuthSpec = {
  authorizeUrl: string
  tokenUrl: string
  /**
   * Google: access_type=offline + prompt=consent (Google returns a refresh token only on the first authorization
   * otherwise). With `include_granted_scopes=true` Google documents that the refresh token represents the
   * combined authorization, so adding a service keeps the earlier scopes.
   */
  authorizeParams?: Readonly<Record<string, string>>
  pkce: boolean
  /** Reads the account's stable subject, human label (email / workspace) and granted scopes. */
  identify: (
    accessToken: string,
    tokenResponse: unknown,
  ) => Promise<{ subject: string; label: string; grantedScopes: readonly string[] }>
}

/**
 * How the agent writes an Account Handle into the credential slot. Default `kurumi:<vendor>/<label>`.
 * A vendor whose SDK validates the credential's shape before sending (a `sk-ant-` prefix check, a JWT parse)
 * overrides it. `parse` returns the handle, or null when the slot holds no selector (the SDK's own placeholder).
 */
export type SelectorShape = {
  format: (handle: string) => string
  parse: (slotValue: string) => string | null
}

export const defaultSelectorShape: SelectorShape = {
  format: (handle) => `kurumi:${handle}`,
  parse: (slotValue) => (slotValue.startsWith('kurumi:') ? slotValue.slice('kurumi:'.length) : null),
}

export type VendorSpec = {
  displayName: string
  /** `key` vendors are added by a human via CLI/Console only. */
  connect: { kind: 'oauth'; oauth: OAuthSpec } | { kind: 'key' }
  services: Readonly<Record<string, ServiceSpec>>
  selectorShape?: SelectorShape
}

function defineCatalog<const T extends Record<string, VendorSpec>>(t: T): T {
  return t
}

const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const catalog = defineCatalog({
  anthropic: {
    displayName: 'Anthropic',
    connect: { kind: 'key' },
    // Whether the Agent SDK / Claude Code rejects a key without the `sk-ant-` prefix is UNVERIFIED (unit 4).
    // If it does, this shape keeps the selector in a form the SDK accepts.
    selectorShape: {
      format: (handle) => `sk-ant-kurumi-${Buffer.from(handle).toString('base64url')}`,
      parse: (v) => (v.startsWith('sk-ant-kurumi-') ? Buffer.from(v.slice(14), 'base64url').toString() : null),
    },
    services: {
      'anthropic-api': {
        displayName: 'Anthropic API',
        hosts: [{ host: 'api.anthropic.com' }],
        slot: { kind: 'bearer' },
        scopes: [],
        containerEnv: (selector) => ({ CLAUDE_CODE_OAUTH_TOKEN: selector }),
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
        authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
        pkce: true,
        identify: notImplemented,
      },
    },
    services: {
      gmail: {
        displayName: 'Gmail',
        hosts: [{ host: 'gmail.googleapis.com' }, { host: 'www.googleapis.com', pathPrefix: '/gmail/' }],
        slot: { kind: 'bearer' },
        scopes: ['https://mail.google.com/'],
        summarize: notImplemented,
      },
      'google-calendar': {
        displayName: 'Google Calendar',
        hosts: [{ host: 'www.googleapis.com', pathPrefix: '/calendar/' }],
        slot: { kind: 'bearer' },
        scopes: ['https://www.googleapis.com/auth/calendar'],
        summarize: notImplemented,
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
        identify: notImplemented,
      },
    },
    services: {
      notion: { displayName: 'Notion', hosts: [{ host: 'api.notion.com' }], slot: { kind: 'bearer' }, scopes: [] },
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
  // TODO add vendors as the user connects them (not OneCLI's ~38 up front).
})

type Catalog = typeof catalog
export type VendorId = keyof Catalog & string
/** Service ids are unique across vendors (a test walks the catalog), so a service alone names its vendor. */
export type ServiceId = { [V in VendorId]: keyof Catalog[V]['services'] & string }[VendorId]

export const vendorIds = Object.keys(catalog) as [VendorId, ...VendorId[]]
export const serviceIds = Object.values(catalog).flatMap((v) => Object.keys(v.services)) as [ServiceId, ...ServiceId[]]

export function vendorOf(service: ServiceId): VendorId {
  // TODO a Map<ServiceId, VendorId> built once from `catalog`
  throw new Error('not implemented')
}

export function serviceSpec(service: ServiceId): ServiceSpec {
  throw new Error('not implemented')
}

export function selectorShapeOf(vendor: VendorId): SelectorShape {
  const spec: VendorSpec = catalog[vendor]
  return spec.selectorShape ?? defaultSelectorShape
}

/**
 * Host + path → the one service whose rule matches, longest pathPrefix first. Services sharing a host are always
 * separated by pathPrefix (checked by a test over `catalog`), so the answer is never ambiguous.
 */
export function serviceFor(host: string, path: string): { vendor: VendorId; service: ServiceId } | null {
  throw new Error('not implemented')
}

/** Hosts the gateway must MITM (every service host). Everything else is tunnelled untouched. */
export function interceptedHosts(): ReadonlySet<string> {
  throw new Error('not implemented')
}

/** Union of scopes for one consent over several services of one vendor. */
export function scopesFor(services: readonly ServiceId[]): string[] {
  throw new Error('not implemented')
}

/** Services of `vendor` whose scopes are all inside `grantedScopes`. Becomes `account.services`. */
export function servicesCovered(vendor: VendorId, grantedScopes: readonly string[]): ServiceId[] {
  throw new Error('not implemented')
}

/** `service IN (…)` per vendor, generated from the catalog for account_grant's CHECK. Never written by hand. */
export function serviceBelongsToVendorSql(serviceColumn: string, vendorColumn: string): string {
  return Object.entries(catalog)
    .map(([vendor, spec]) => {
      const services = Object.keys(spec.services)
        .map((s) => `'${s}'`)
        .join(',')
      return `(${vendorColumn} = '${vendor}' AND ${serviceColumn} IN (${services}))`
    })
    .join(' OR ')
}
