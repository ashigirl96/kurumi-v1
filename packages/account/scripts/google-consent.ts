import { parseArgs } from 'node:util'

import {
  catalog,
  IdentifyError,
  isRecord,
  servicesCovered,
  type Identity,
  type ServiceId,
  type TokenResponse,
} from '../src/catalog.ts'
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  OAuthError,
  readCallback,
  refresh,
  type CallbackResult,
  type OAuthClient,
} from '../src/oauth.ts'

const googleServices = Object.keys(catalog.google.services) as readonly ServiceId[]

const USAGE = `usage: bun packages/account/scripts/google-consent.ts (--services <ids> | --add <ids>) [flags]

  --services <ids>  consent to these services (${googleServices.join(', ')}) as a fresh grant, without merging an earlier one
  --add <ids>       consent to more services; Google merges them into the earlier grant (include_granted_scopes)
  --refresh         refresh once with the new refresh token and print the refreshed grant
  --probe           call the Gmail and Calendar APIs with the new access token and check each status against the services the grant covers
  --reuse-code      exchange the same code a second time and print Google's refusal (runs after --refresh and --probe)
  --revoke          revoke the refresh token this run obtained and check that refreshing with it then fails
  --mask            print the email as a***@domain and the subject as its first and last 4 characters
  --port <n>        callback port on 127.0.0.1 (default: any free port)
  --timeout <s>     seconds to wait for the browser callback (default: 300)

The client comes from KURUMI_GOOGLE_CLIENT_ID and KURUMI_GOOGLE_CLIENT_SECRET.
No token is written to a file or printed. Failure reasons go to stderr, so capture both streams.`

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const PROBES = [
  { service: 'gmail', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' },
  {
    service: 'google-calendar',
    url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  },
] as const

type Options = Readonly<{
  services: readonly ServiceId[]
  mergesEarlierGrant: boolean
  refresh: boolean
  probe: boolean
  reuseCode: boolean
  revoke: boolean
  mask: boolean
  port: number
  timeoutSeconds: number
}>

class UsageError extends Error {}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

const attempt = <T>(promise: Promise<T>): Promise<Attempt<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

const out = (line: string) => console.log(line)
const fail = (line: string) => console.error(line)

function parseServices(raw: string): readonly ServiceId[] {
  return raw.split(',').map((id) => {
    const service = googleServices.find((known) => known === id)
    if (service === undefined) throw new UsageError(`unknown service id: ${id}`)
    return service
  })
}

function parseCount(name: string, raw: string, max: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new UsageError(`--${name} must be an integer from 0 to ${max}, got ${raw}`)
  }
  return value
}

function parseOptions(argv: readonly string[]): Options {
  const parsed = attemptSync(() =>
    parseArgs({
      args: [...argv],
      options: {
        services: { type: 'string' },
        add: { type: 'string' },
        refresh: { type: 'boolean', default: false },
        probe: { type: 'boolean', default: false },
        'reuse-code': { type: 'boolean', default: false },
        revoke: { type: 'boolean', default: false },
        mask: { type: 'boolean', default: false },
        port: { type: 'string', default: '0' },
        timeout: { type: 'string', default: '300' },
      },
      strict: true,
    }),
  )
  if (!parsed.ok) throw new UsageError(describe(parsed.error))
  const { values } = parsed.value
  if ((values.services === undefined) === (values.add === undefined)) {
    throw new UsageError('pass exactly one of --services and --add')
  }
  return {
    services: parseServices(values.services ?? values.add ?? ''),
    mergesEarlierGrant: values.add !== undefined,
    refresh: values.refresh,
    probe: values.probe,
    reuseCode: values['reuse-code'],
    revoke: values.revoke,
    mask: values.mask,
    port: parseCount('port', values.port, 65535),
    timeoutSeconds: parseCount('timeout', values.timeout, 86400),
  }
}

function attemptSync<T>(run: () => T): Attempt<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error }
  }
}

function readClient(): OAuthClient {
  const clientId = process.env.KURUMI_GOOGLE_CLIENT_ID
  const clientSecret = process.env.KURUMI_GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new UsageError('KURUMI_GOOGLE_CLIENT_ID and KURUMI_GOOGLE_CLIENT_SECRET are not set.')
  }
  return { clientId, clientSecret }
}

const maskEmail = (email: string): string => {
  const at = email.indexOf('@')
  return at <= 0 ? '***' : `${email.slice(0, 1)}***${email.slice(at)}`
}

const maskSubject = (subject: string): string =>
  subject.length <= 8 ? '***' : `${subject.slice(0, 4)}...${subject.slice(-4)}`

function printScopes(prefix: string, grantedScopes: readonly string[]): void {
  out(`${prefix}grantedScopes: ${grantedScopes.join(' ')}`)
  out(`${prefix}servicesCovered: ${servicesCovered('google', grantedScopes).join(', ')}`)
}

function printGrant(grant: Identity, mask: boolean): void {
  out(`subject: ${mask ? maskSubject(grant.subject) : grant.subject}`)
  out(`label: ${mask ? maskEmail(grant.label) : grant.label}`)
  printScopes('', grant.grantedScopes)
}

function listenForCallback(port: number, state: string) {
  const callback = Promise.withResolvers<Exclude<CallbackResult, { kind: 'invalid' }>>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/oauth/callback') return new Response('not found', { status: 404 })
      const result = readCallback(url, state)
      if (result.kind === 'invalid') return new Response(result.reason, { status: 400 })
      callback.resolve(result)
      return new Response('You can close this tab and go back to the terminal.', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    },
  })
  return { server, callback: callback.promise }
}

async function revokeAndCheck(
  client: OAuthClient,
  obtained: readonly TokenResponse[],
): Promise<boolean> {
  const refreshTokens = obtained.flatMap(({ refreshToken }) => refreshToken ?? [])
  if (refreshTokens.length === 0) {
    fail('--revoke found no refresh token to revoke, so nothing was checked.')
    return false
  }
  let ok = true
  for (const [index, token] of refreshTokens.entries()) {
    const label = `refresh_token #${index + 1}`
    const revoked = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
    out(`revoke ${label}: HTTP ${revoked.status}`)
    if (revoked.status !== 200) {
      ok = false
      fail(`Google did not accept the revoke of ${label}.`)
    }
    const outcome = await attempt(refresh({ vendor: 'google', client, refreshToken: token }))
    if (
      !outcome.ok &&
      outcome.error instanceof OAuthError &&
      outcome.error.code === 'invalid_grant'
    ) {
      out(`refresh with revoked ${label}: refused (invalid_grant)`)
    } else {
      ok = false
      fail(
        `refresh with revoked ${label}: ${outcome.ok ? 'Google still issued an access token' : describe(outcome.error)}`,
      )
    }
  }
  return ok
}

function refusalReasons(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) return ''
  const { status, errors, details } = body.error
  const reasons = [errors, details].flatMap((list) =>
    Array.isArray(list)
      ? list.flatMap((entry: unknown) =>
          isRecord(entry) && typeof entry.reason === 'string' ? [entry.reason] : [],
        )
      : [],
  )
  return [typeof status === 'string' ? status : [], ...reasons].flat().join(' ')
}

async function probeApis(accessToken: string, covered: readonly ServiceId[]): Promise<boolean> {
  let ok = true
  for (const { service, url } of PROBES) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
    const expected = covered.includes(service) ? 200 : 403
    const reasons = response.ok ? '' : refusalReasons(await response.json().catch(() => null))
    out(
      `probe ${service}: GET ${url} -> HTTP ${response.status}${reasons === '' ? '' : ` (${reasons})`}, expected ${expected}`,
    )
    if (response.status !== expected) {
      ok = false
      fail(`The ${service} probe answered ${response.status}, not the expected ${expected}.`)
    }
  }
  return ok
}

async function exercise(input: {
  options: Options
  client: OAuthClient
  first: TokenResponse
  covered: readonly ServiceId[]
  exchange: () => Promise<TokenResponse>
  obtained: TokenResponse[]
}): Promise<boolean> {
  const { options, client, first, covered, exchange, obtained } = input
  let ok = true
  if (options.refresh) {
    if (first.refreshToken === null) {
      ok = false
      fail('Google sent no refresh token, so there is nothing to refresh with.')
    } else {
      const refreshed = await refresh({
        vendor: 'google',
        client,
        refreshToken: first.refreshToken,
      })
      printScopes(
        'refreshed ',
        refreshed.scope === null ? [] : refreshed.scope.split(' ').filter((scope) => scope !== ''),
      )
    }
  }
  if (options.probe) ok = (await probeApis(first.accessToken, covered)) && ok
  if (options.reuseCode) {
    const second = await attempt(exchange())
    if (second.ok) {
      obtained.push(second.value)
      ok = false
      fail('The second exchange of the same code was accepted, which Google should refuse.')
    } else if (second.error instanceof OAuthError) {
      out(
        `second exchange of the same code: refused (${second.error.code}). ${second.error.message}`,
      )
    } else {
      throw second.error
    }
  }
  return ok
}

async function consent(options: Options): Promise<boolean> {
  const client = readClient()
  const pkce = createPkce()
  const state = createState()
  const { server, callback } = listenForCallback(options.port, state)
  const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`
  try {
    const url = authorizeUrl({
      vendor: 'google',
      services: options.services,
      client,
      redirectUri,
      state,
      challenge: pkce.challenge,
      mergesEarlierGrant: options.mergesEarlierGrant,
    })
    out(`authorize_url: ${url.href}`)
    out(`waiting up to ${options.timeoutSeconds}s for the browser callback on ${redirectUri}`)
    const timedOut = Symbol('timed out')
    const timer = Promise.withResolvers<typeof timedOut>()
    const timeout = setTimeout(() => timer.resolve(timedOut), options.timeoutSeconds * 1000)
    const result = await Promise.race([callback, timer.promise])
    clearTimeout(timeout)
    if (result === timedOut) {
      fail(`No callback arrived within ${options.timeoutSeconds}s, so no code was exchanged.`)
      return false
    }
    if (result.kind === 'denied') {
      fail(
        `Consent was not given: Google sent error=${result.error} to the callback. No code was issued, so the token endpoint was not called.`,
      )
      return false
    }

    const exchange = () =>
      exchangeCode({
        vendor: 'google',
        client,
        code: result.code,
        verifier: pkce.verifier,
        redirectUri,
      })
    const obtained: TokenResponse[] = []
    const run = await attempt(
      (async () => {
        const first = await exchange()
        obtained.push(first)
        const grant = catalog.google.connect.oauth.identify(first)
        printGrant(grant, options.mask)
        out(`refresh_token: ${first.refreshToken === null ? 'absent' : 'present'}`)
        return exercise({
          options,
          client,
          first,
          covered: servicesCovered('google', grant.grantedScopes),
          exchange,
          obtained,
        })
      })(),
    )
    const revoked = options.revoke ? await revokeAndCheck(client, obtained) : true
    if (!run.ok) throw run.error
    return run.value && revoked
  } finally {
    await server.stop(true)
  }
}

async function main(): Promise<number> {
  try {
    return (await consent(parseOptions(process.argv.slice(2)))) ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`${error.message}\n\n${USAGE}`)
      return 2
    }
    if (error instanceof OAuthError || error instanceof IdentifyError) {
      fail(error.message)
      return 1
    }
    throw error
  }
}

process.exit(await main())
