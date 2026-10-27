import { describe, expect, spyOn, test } from 'bun:test'

import { catalog, IdentifyError, servicesCovered, type ServiceId } from './catalog.ts'
import { refreshFull, tokenFull, tokenGmailOnly } from './fixtures/google/token-responses.ts'
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  OAuthError,
  parseTokenResponse,
  readCallback,
  refresh,
  s256Challenge,
} from './oauth.ts'

const client = { clientId: 'example-client-id', clientSecret: 'example-client-secret' }
const redirectUri = 'http://127.0.0.1:43210/oauth/callback'
const googleOAuth = catalog.google.connect.oauth

type Fetch = typeof fetch

type Captured = { url: string; method: string; contentType: string | null; form: URLSearchParams }

function respondWith(status: number, body: unknown): { fetch: Fetch; sent: Captured[] } {
  const sent: Captured[] = []
  const fake = (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const request = new Request(input, init)
    return request.text().then((text) => {
      sent.push({
        url: request.url,
        method: request.method,
        contentType: request.headers.get('content-type'),
        form: new URLSearchParams(text),
      })
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      return new Response(payload, { status })
    })
  }
  return { fetch: fake as Fetch, sent }
}

const authorize = (
  services: readonly ServiceId[],
  extra: { challenge?: string; mergesEarlierGrant?: boolean } = {},
) =>
  authorizeUrl({
    vendor: 'google',
    services,
    client,
    redirectUri,
    state: 'state-1',
    challenge: extra.challenge ?? 'example-challenge',
    ...(extra.mergesEarlierGrant === undefined
      ? {}
      : { mergesEarlierGrant: extra.mergesEarlierGrant }),
  })

describe('PKCE', () => {
  test('s256Challenge matches the RFC 7636 appendix B vector', () => {
    expect(s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  test('createPkce returns a fresh verifier of legal length whose challenge is its S256', () => {
    const first = createPkce()
    const second = createPkce()

    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(first.challenge).toBe(s256Challenge(first.verifier))
    expect(second.verifier).not.toBe(first.verifier)
  })
})

describe('createState', () => {
  test('is fresh on every call and safe in a URL', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(createState()).not.toBe(createState())
  })
})

describe('authorizeUrl', () => {
  test('asks for the scopes of the services plus the identity scopes, and nothing else', () => {
    const url = authorize(['gmail', 'google-calendar'])

    expect(`${url.origin}${url.pathname}`).toBe(googleOAuth.authorizeUrl)
    expect(url.searchParams.get('scope')?.split(' ').toSorted()).toEqual([
      'email',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar',
      'openid',
    ])
  })

  test('adding one service requests only that scope and relies on include_granted_scopes for the rest', () => {
    const url = authorize(['google-calendar'])

    expect(url.searchParams.get('scope')?.split(' ').toSorted()).toEqual([
      'email',
      'https://www.googleapis.com/auth/calendar',
      'openid',
    ])
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
  })

  test('carries the catalog parameters, the PKCE challenge, the state and the redirect', () => {
    const params = authorize(['gmail'], {
      challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    }).searchParams

    expect(Object.fromEntries(params)).toMatchObject({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: 'state-1',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
  })

  test('asks for a fresh grant, without merging the earlier one, when told to', () => {
    const params = authorize(['gmail'], { mergesEarlierGrant: false }).searchParams

    expect(params.has('include_granted_scopes')).toBe(false)
    expect(params.get('prompt')).toBe('consent')
  })

  test('never puts the client secret in the URL the browser sees', () => {
    expect(authorize(['gmail']).href).not.toContain(client.clientSecret)
  })

  test('refuses a service that belongs to another vendor', () => {
    expect(() => authorize(['gmail', 'anthropic-api'])).toThrow(/anthropic-api/)
  })
})

const callback = (query: string) => new URL(`${redirectUri}?${query}`)

describe('readCallback', () => {
  test('returns the code when the state matches', () => {
    expect(readCallback(callback('state=s1&code=4%2Fabc'), 's1')).toEqual({
      kind: 'code',
      code: '4/abc',
    })
  })

  test('reports a refused consent with the error Google sent', () => {
    expect(readCallback(callback('state=s1&error=access_denied'), 's1')).toEqual({
      kind: 'denied',
      error: 'access_denied',
    })
  })

  test('rejects a callback whose state is not ours, even when it carries a code', () => {
    expect(readCallback(callback('state=other&code=abc'), 's1')).toMatchObject({ kind: 'invalid' })
  })

  test('rejects a callback whose state is not ours, even when it carries an error', () => {
    expect(readCallback(callback('state=other&error=access_denied'), 's1')).toMatchObject({
      kind: 'invalid',
    })
    expect(readCallback(callback('error=access_denied'), 's1')).toMatchObject({ kind: 'invalid' })
  })

  test('rejects a callback with neither a code nor an error', () => {
    expect(readCallback(callback('state=s1'), 's1')).toMatchObject({ kind: 'invalid' })
  })
})

describe('exchangeCode', () => {
  test('posts the code and the PKCE verifier to the token endpoint and parses the response', async () => {
    const { fetch, sent } = respondWith(200, tokenFull)

    const tokens = await exchangeCode({
      vendor: 'google',
      client,
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri,
      fetch,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      url: googleOAuth.tokenUrl,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
    })
    expect(Object.fromEntries(sent[0]?.form ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    })
    expect(tokens).toMatchObject({
      accessToken: tokenFull.access_token,
      refreshToken: tokenFull.refresh_token,
      tokenType: 'Bearer',
      expiresIn: 3599,
      scope: tokenFull.scope,
      idToken: tokenFull.id_token,
    })
  })

  test('explains invalid_grant as a spent, expired or mismatched code', async () => {
    const { fetch } = respondWith(400, {
      error: 'invalid_grant',
      error_description: 'Bad Request',
    })

    const failure = await exchangeCode({
      vendor: 'google',
      client,
      code: 'used-code',
      verifier: 'verifier-1',
      redirectUri,
      fetch,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(OAuthError)
    expect(failure).toMatchObject({ code: 'invalid_grant', status: 400 })
    expect((failure as OAuthError).message).toMatch(/Google refused the authorization code/)
    expect((failure as OAuthError).message).toMatch(/already used|expired/)
  })

  test('reports a body that is not an OAuth error as an unexpected response', async () => {
    const { fetch } = respondWith(502, '<html>bad gateway</html>')

    const failure = await exchangeCode({
      vendor: 'google',
      client,
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri,
      fetch,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unexpected_response', status: 502 })
  })

  test('rejects a 200 response that has no access token', async () => {
    const { fetch } = respondWith(200, { token_type: 'Bearer' })

    const failure = await exchangeCode({
      vendor: 'google',
      client,
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri,
      fetch,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unexpected_response' })
  })
})

describe('refresh', () => {
  test('posts the refresh token and returns the new scope without a new refresh token', async () => {
    const { fetch, sent } = respondWith(200, refreshFull)

    const tokens = await refresh({ vendor: 'google', client, refreshToken: 'rt-1', fetch })

    expect(Object.fromEntries(sent[0]?.form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: client.clientId,
      client_secret: client.clientSecret,
    })
    expect(tokens.refreshToken).toBeNull()
    expect(tokens.accessToken).toBe(refreshFull.access_token)
    expect(tokens.scope).toBe(refreshFull.scope)
  })

  test('explains invalid_grant as a revoked, expired or replaced refresh token', async () => {
    const { fetch } = respondWith(400, { error: 'invalid_grant' })

    const failure = await refresh({
      vendor: 'google',
      client,
      refreshToken: 'revoked',
      fetch,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'invalid_grant' })
    expect((failure as OAuthError).message).toMatch(/Google refused the refresh token/)
    expect((failure as OAuthError).message).toMatch(/revoked/)
  })
})

const identify = (response: unknown) => googleOAuth.identify(parseTokenResponse(response))

describe('Google identify', () => {
  test('names the account by the id_token sub and email, and the grant by the response scope', () => {
    const identity = identify(tokenFull)

    expect(identity.subject).toBe('100000000000000000001')
    expect(identity.label).toBe('alice@example.com')
    expect(identity.grantedScopes.toSorted()).toEqual(tokenFull.scope.split(' ').toSorted())
  })

  test('a full grant covers gmail and google-calendar', () => {
    const { grantedScopes } = identify(tokenFull)

    expect(servicesCovered('google', grantedScopes)).toEqual(['gmail', 'google-calendar'])
  })

  test('a grant without the calendar scope covers gmail alone', () => {
    const { grantedScopes } = identify(tokenGmailOnly)

    expect(servicesCovered('google', grantedScopes)).toEqual(['gmail'])
  })

  test('refuses a response with no scope, because the grant is unknown', () => {
    const { scope: _dropped, ...withoutScope } = tokenFull

    expect(() => identify(withoutScope)).toThrow(IdentifyError)
  })

  test('refuses a response with no id_token, because the account cannot be named', () => {
    const { id_token: _dropped, ...withoutIdToken } = tokenFull

    expect(() => identify(withoutIdToken)).toThrow(IdentifyError)
  })

  test('refuses an id_token that has no email claim', () => {
    const claims = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url')

    expect(() => identify({ ...tokenFull, id_token: `e30.${claims}.` })).toThrow(IdentifyError)
  })

  test('refuses an id_token that is not a JWT', () => {
    expect(() => identify({ ...tokenFull, id_token: 'not-a-jwt' })).toThrow(IdentifyError)
  })
})

test('code exchange and refresh share a thirty-second deadline for a stalled token endpoint', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const deadline = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    expect(ms).toBe(30_000)
    return timeout(5)
  })
  const fetchImpl: typeof fetch = Object.assign(
    (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('missing token request deadline')
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    { preconnect: fetch.preconnect },
  )
  try {
    const exchangeError = await exchangeCode({
      vendor: 'google',
      client,
      code: 'code',
      verifier: 'verifier',
      redirectUri,
      fetch: fetchImpl,
    }).catch((error: unknown) => error)
    expect(exchangeError).toMatchObject({ name: 'TimeoutError' })
    const refreshError = await refresh({
      vendor: 'google',
      client,
      refreshToken: 'refresh',
      fetch: fetchImpl,
    }).catch((error: unknown) => error)
    expect(refreshError).toMatchObject({ name: 'TimeoutError' })
    expect(deadline).toHaveBeenCalledTimes(2)
  } finally {
    deadline.mockRestore()
  }
})
