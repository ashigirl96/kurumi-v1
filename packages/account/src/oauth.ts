import {
  catalog,
  isRecord,
  scopesFor,
  vendorOf,
  type OAuthSpec,
  type ServiceId,
  type TokenResponse,
} from './catalog.ts'

export type OAuthVendorId = 'google'

export type OAuthClient = Readonly<{ clientId: string; clientSecret: string }>

export type Pkce = Readonly<{ verifier: string; challenge: string }>

export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'denied'; error: string }
  | { kind: 'invalid'; reason: string }

type Fetch = typeof fetch

export class OAuthError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const oauthOf = (vendor: OAuthVendorId): OAuthSpec => catalog[vendor].connect.oauth

export function s256Challenge(verifier: string): string {
  return new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')
}

const randomBase64url = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

export function createPkce(): Pkce {
  const verifier = randomBase64url(32)
  return { verifier, challenge: s256Challenge(verifier) }
}

export const createState = (): string => randomBase64url(16)

export function authorizeUrl(input: {
  vendor: OAuthVendorId
  services: readonly ServiceId[]
  client: OAuthClient
  redirectUri: string
  state: string
  challenge: string
  mergesEarlierGrant?: boolean
}): URL {
  const { vendor, services, client, redirectUri, state, challenge } = input
  const oauth = oauthOf(vendor)
  const foreign = services.filter((service) => vendorOf(service) !== vendor)
  if (foreign.length > 0) {
    throw new Error(`${foreign.join(', ')} cannot be requested from ${catalog[vendor].displayName}`)
  }
  const scope = [...new Set([...scopesFor(services), ...oauth.identityScopes])].join(' ')
  const url = new URL(oauth.authorizeUrl)
  const params: Record<string, string> = {
    ...oauth.authorizeParams,
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    ...(scope === '' ? {} : { scope }),
    ...(oauth.pkce ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
  }
  if (input.mergesEarlierGrant === false) delete params.include_granted_scopes
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url
}

export function readCallback(url: URL, expectedState: string): CallbackResult {
  if (url.searchParams.get('state') !== expectedState) {
    return { kind: 'invalid', reason: 'The callback carried a state this run did not issue.' }
  }
  const error = url.searchParams.get('error')
  if (error !== null) return { kind: 'denied', error }
  const code = url.searchParams.get('code')
  if (code === null || code === '') {
    return { kind: 'invalid', reason: 'The callback carried neither a code nor an error.' }
  }
  return { kind: 'code', code }
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function parseTokenResponse(body: unknown): TokenResponse {
  if (
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    typeof body.token_type !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new OAuthError(
      'The token endpoint answered 200 without an access_token, token_type and expires_in.',
      'unexpected_response',
      200,
    )
  }
  return {
    accessToken: body.access_token,
    tokenType: body.token_type,
    expiresIn: body.expires_in,
    scope: stringOrNull(body.scope),
    refreshToken: stringOrNull(body.refresh_token),
    idToken: stringOrNull(body.id_token),
  }
}

function explainRefusal(vendorName: string, grant: Grant, error: string, detail: string): string {
  if (error === 'invalid_grant') {
    return grant === 'authorization_code'
      ? `${vendorName} refused the authorization code (invalid_grant). A code works once and for a few minutes, so this one was already used, has expired, or was issued for another redirect URI or PKCE verifier.`
      : `${vendorName} refused the refresh token (invalid_grant). The token was revoked, has expired, or was replaced by a newer one.`
  }
  return `${vendorName} refused the request (${error})${detail === '' ? '' : `: ${detail}`}.`
}

type Grant = 'authorization_code' | 'refresh_token'

async function requestToken(
  vendor: OAuthVendorId,
  grant: Grant,
  form: Record<string, string>,
  fetchImpl: Fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(oauthOf(vendor).tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: grant, ...form }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) return parseTokenResponse(body)
  if (isRecord(body) && typeof body.error === 'string') {
    const detail = stringOrNull(body.error_description) ?? ''
    throw new OAuthError(
      explainRefusal(catalog[vendor].displayName, grant, body.error, detail),
      body.error,
      response.status,
    )
  }
  throw new OAuthError(
    `${catalog[vendor].displayName} answered ${response.status} with a body that is not an OAuth error.`,
    'unexpected_response',
    response.status,
  )
}

export function exchangeCode(input: {
  vendor: OAuthVendorId
  client: OAuthClient
  code: string
  verifier: string
  redirectUri: string
  fetch?: Fetch
}): Promise<TokenResponse> {
  const { vendor, client, code, verifier, redirectUri } = input
  return requestToken(
    vendor,
    'authorization_code',
    {
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...(oauthOf(vendor).pkce ? { code_verifier: verifier } : {}),
    },
    input.fetch ?? fetch,
  )
}

export function refresh(input: {
  vendor: OAuthVendorId
  client: OAuthClient
  refreshToken: string
  fetch?: Fetch
}): Promise<TokenResponse> {
  const { vendor, client, refreshToken } = input
  return requestToken(
    vendor,
    'refresh_token',
    { refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret },
    input.fetch ?? fetch,
  )
}
