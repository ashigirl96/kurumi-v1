import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request, type RequestOptions } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { PassThrough, pipeline, type Duplex } from 'node:stream'

import {
  headerNameAsRead,
  type AccountHandle,
  type AccountLedger,
  type CredentialPrincipal,
  type ServiceId,
} from '@kurumi/account/server'

import { addressRefusal, hostAddresses } from './address.ts'
import { REFUSAL_STATUS, refusalHttp, refusalResponse, type GatewayRefusal } from './refusal.ts'

export type ConnectTarget = { host: string; port: number }

export type InjectionInput<Principal> = ConnectTarget & {
  principal: Principal
  method: string
  path: string
  headers: Headers
  rawHeaders: readonly string[]
}

export type Forwarded = {
  path: string
  headers: Headers
  account?: { handle: AccountHandle; service: ServiceId }
}

type Injected = Forwarded | { refusal: GatewayRefusal }

export type EgressDecision =
  | { decision: 'injected'; account: AccountHandle; service: ServiceId }
  | { decision: 'passed' }
  | { decision: 'refused'; refusal: GatewayRefusal['code']; service: ServiceId | null }

export type EgressEvent<Principal> = EgressDecision & {
  principal: Principal
  at: number
  host: string
  method: string
  path: string
  status: number | null
  durationMs: number
}

export type UpstreamDestination = {
  host: string
  address: string
  port?: number
  caPem: string
}

export type ForwardDeps<Principal> = {
  inject(input: InjectionInput<Principal>): Injected | Promise<Injected>
  upstream?: UpstreamDestination
  resolve?: (host: string) => Promise<LookupAddress[]>
  addressRefusal?: (address: string, host: readonly string[]) => string | null
  hostAddresses?: () => readonly string[]
  log?(event: EgressEvent<Principal>): void
}

const resolveAll = (host: string) => lookup(host, { all: true })

export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    const [first] = addresses
    if (!first) callback(new Error(`${hostname} resolved to no address`), '')
    else if (options.all) callback(null, addresses)
    else callback(null, first.address, first.family)
  }
}

type Pinned =
  | { kind: 'pinned'; lookup: LookupFunction }
  | { kind: 'refused'; refusal: GatewayRefusal }
  | { kind: 'unreachable' }

async function pinPublicUpstream(
  host: string,
  {
    resolve = resolveAll,
    addressRefusal: refusalOf = addressRefusal,
    hostAddresses: readHostAddresses = hostAddresses,
  }: Pick<ForwardDeps<unknown>, 'resolve' | 'addressRefusal' | 'hostAddresses'>,
): Promise<Pinned> {
  let addresses: LookupAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    return { kind: 'unreachable' }
  }
  if (addresses.length === 0) return { kind: 'unreachable' }
  const ownAddresses = readHostAddresses()
  const reason = addresses
    .map(({ address }) => refusalOf(address, ownAddresses))
    .find((found) => found !== null)
  if (reason) return { kind: 'refused', refusal: { code: 'upstream_not_public', host, reason } }
  return { kind: 'pinned', lookup: pinnedLookup(addresses) }
}

export function credentialInject(
  ledger: Pick<AccountLedger, 'credentialFor'>,
): ForwardDeps<CredentialPrincipal>['inject'] {
  return ({ principal, host, port, method, path, headers, rawHeaders }) => {
    if (port !== 443) return { refusal: { code: 'port_not_allowed', host, port } }
    const decision = ledger.credentialFor(principal, { host, method, path, headers, rawHeaders })
    switch (decision.kind) {
      case 'inject':
        return {
          ...decision.injection.apply(),
          account: {
            handle: decision.injection.handle,
            service: decision.injection.service,
          },
        }
      case 'refuse':
        return { refusal: decision.refusal }
      case 'pass':
        return { path, headers }
    }
  }
}

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

function withoutHopHeaders(headers: Headers): Headers {
  const result = new Headers(headers)
  const nominated = new Set(
    headers
      .get('connection')
      ?.toLowerCase()
      .split(',')
      .map((name) => name.trim()),
  )
  for (const name of headers.keys()) {
    if (hopHeaders.includes(name) || nominated.has(name)) result.delete(name)
  }
  return result
}

/** `writeHead` throws on a non-Latin1 or control character, and a label is any text. */
function replaceAccountHeader(headers: Headers, account: AccountHandle | undefined): Headers {
  const replaced = new Headers(
    [...headers].filter(([name]) => headerNameAsRead(name) !== 'x-kurumi-account'),
  )
  if (account !== undefined) replaced.set('x-kurumi-account', encodeURI(account.toWellFormed()))
  return replaced
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]
    const value = req.rawHeaders[index + 1]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }
  return headers
}

export function authority(target: ConnectTarget): string {
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host
  return target.port === 443 ? host : `${host}:${target.port}`
}

type Prepared =
  | {
      kind: 'forward'
      options: Omit<RequestOptions, 'headers'> & { headers: Record<string, string> }
      account?: AccountHandle
      decision: EgressDecision
    }
  | { kind: 'bad_request' }
  | { kind: 'refused'; refusal: GatewayRefusal; decision: EgressDecision }
  | { kind: 'unreachable'; decision: EgressDecision }

function refusedDecision(refusal: GatewayRefusal): EgressDecision {
  return {
    decision: 'refused',
    refusal: refusal.code,
    service: 'service' in refusal ? refusal.service : null,
  }
}

function forwardedDecision({ account }: Forwarded): EgressDecision {
  return account
    ? { decision: 'injected', account: account.handle, service: account.service }
    : { decision: 'passed' }
}

function pathWithoutQuery(path: string): string {
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

function egressRecorder<Principal>(
  context: { principal: Principal; target: ConnectTarget },
  req: IncomingMessage,
  deps: ForwardDeps<Principal>,
): (decision: EgressDecision, status: number | null) => void {
  const at = Date.now()
  const started = performance.now()
  return (decision, status) =>
    deps.log?.({
      ...decision,
      principal: context.principal,
      at,
      host: context.target.host,
      method: req.method ?? 'GET',
      path: pathWithoutQuery(req.url ?? '/'),
      status,
      durationMs: Math.round(performance.now() - started),
    })
}

async function prepareRequest<Principal>(
  context: { principal: Principal; target: ConnectTarget; signal: AbortSignal },
  req: IncomingMessage,
  deps: ForwardDeps<Principal>,
): Promise<Prepared> {
  const { target } = context
  const path = req.url ?? '/'
  const host = req.headers.host?.toLowerCase()
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    !host ||
    (host !== authority(target) && !(target.port === 443 && host === `${authority(target)}:443`))
  ) {
    return { kind: 'bad_request' }
  }
  const injected = await deps.inject({
    principal: context.principal,
    ...target,
    method: req.method ?? 'GET',
    path,
    headers: withoutHopHeaders(requestHeaders(req)),
    rawHeaders: [...req.rawHeaders],
  })
  if ('refusal' in injected) {
    return {
      kind: 'refused',
      refusal: injected.refusal,
      decision: refusedDecision(injected.refusal),
    }
  }
  const decision = forwardedDecision(injected)
  const destination = deps.upstream?.host === target.host ? deps.upstream : undefined
  const pinned = destination ? undefined : await pinPublicUpstream(target.host, deps)
  if (pinned?.kind === 'refused') {
    return { ...pinned, decision: refusedDecision(pinned.refusal) }
  }
  if (pinned?.kind === 'unreachable') return { kind: 'unreachable', decision }
  const headers = withoutHopHeaders(injected.headers)
  headers.set('host', authority(target))
  headers.delete('content-length')
  if (req.headers['transfer-encoding'] !== undefined) {
    headers.set('transfer-encoding', req.headers['transfer-encoding'])
  } else if (req.headers['content-length'] !== undefined) {
    headers.set('content-length', req.headers['content-length'])
  }
  return {
    kind: 'forward',
    options: {
      hostname: destination?.address ?? target.host,
      port: destination?.port ?? target.port,
      lookup: pinned?.lookup,
      servername: isIP(target.host) ? undefined : target.host,
      ca: destination?.caPem,
      method: req.method,
      path: injected.path,
      headers: Object.fromEntries(headers),
      agent: false,
    },
    account: injected.account?.handle,
    decision,
  }
}

function respondUnreachable(res: ServerResponse, host: string): void {
  res.writeHead(502, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error: 'upstream_unreachable', host }))
}

function respondAfterBodyDrains(req: IncomingMessage, respond: () => void): void {
  req.resume()
  if (req.complete) respond()
  else req.once('end', respond)
}

const badGateway = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

export async function forward<Principal>(
  context: { principal: Principal; target: ConnectTarget; signal: AbortSignal },
  req: IncomingMessage,
  res: ServerResponse,
  deps: ForwardDeps<Principal>,
): Promise<void> {
  const record = egressRecorder(context, req, deps)
  const prepared = await prepareRequest(context, req, deps)
  const gone = context.signal.aborted || res.destroyed
  if (prepared.kind === 'bad_request') {
    if (!gone) res.writeHead(400, { connection: 'close' }).end()
    return
  }
  const { decision } = prepared
  if (gone) {
    record(decision, null)
    return
  }
  res.once('close', () => record(decision, res.headersSent ? res.statusCode : null))
  if (prepared.kind === 'refused') {
    const { status, headers, body } = refusalResponse(prepared.refusal)
    respondAfterBodyDrains(req, () => res.writeHead(status, headers).end(body))
    return
  }
  if (prepared.kind === 'unreachable') {
    respondAfterBodyDrains(req, () => respondUnreachable(res, context.target.host))
    return
  }
  const { options, account } = prepared
  const body = new PassThrough()
  const upstream = request(options)

  const cancel = () => {
    upstream.destroy()
    body.destroy()
  }
  const responseClosed = () => {
    if (!res.writableFinished) cancel()
  }
  context.signal.addEventListener('abort', cancel, { once: true })
  req.once('aborted', cancel)
  req.once('error', cancel)
  res.once('close', responseClosed)
  upstream.once('close', () => {
    context.signal.removeEventListener('abort', cancel)
    req.off('aborted', cancel)
    req.off('error', cancel)
    res.off('close', responseClosed)
    req.unpipe(body)
    body.destroy()
  })
  upstream.once('error', () => {
    if (res.destroyed) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    respondUnreachable(res, context.target.host)
  })
  upstream.once('response', (response) => {
    const responseHeaders = replaceAccountHeader(
      withoutHopHeaders(requestHeaders(response)),
      account,
    )
    const outgoing: Record<string, string | string[]> = Object.fromEntries(responseHeaders)
    const cookies = responseHeaders.getSetCookie()
    if (cookies.length) outgoing['set-cookie'] = cookies
    res.writeHead(response.statusCode ?? 502, outgoing)
    pipeline(response, res, (error) => {
      if (error) cancel()
    })
  })
  req.pipe(body)
  pipeline(body, upstream, (error) => {
    if (error) body.destroy()
  })
}

export async function forwardUpgrade<Principal>(
  context: { principal: Principal; target: ConnectTarget; signal: AbortSignal },
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  deps: ForwardDeps<Principal>,
): Promise<void> {
  if (
    req.method !== 'GET' ||
    req.headers.upgrade?.toLowerCase() !== 'websocket' ||
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
  ) {
    client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const record = egressRecorder(context, req, deps)
  const prepared = await prepareRequest(context, req, deps)
  const gone = context.signal.aborted || client.destroyed
  if (prepared.kind === 'bad_request') {
    if (!gone) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
    return
  }
  const { decision } = prepared
  if (gone) {
    record(decision, null)
    return
  }
  let status: number | null = null
  client.once('close', () => record(decision, status))
  if (prepared.kind === 'refused') {
    status = REFUSAL_STATUS[prepared.refusal.code]
    client.end(refusalHttp(prepared.refusal))
    return
  }
  if (prepared.kind === 'unreachable') {
    status = 502
    client.end(badGateway)
    return
  }
  const { options, account } = prepared
  const upstream = request({
    ...options,
    headers: { ...options.headers, connection: 'Upgrade', upgrade: 'websocket' },
  })
  let upgraded: Duplex | undefined
  const cancel = () => {
    upstream.destroy()
    upgraded?.destroy()
  }
  const cleanup = () => {
    cancel()
    context.signal.removeEventListener('abort', cancel)
  }
  context.signal.addEventListener('abort', cancel, { once: true })
  upstream.once('close', () => {
    if (!upgraded) cleanup()
  })
  upstream.once('error', () => {
    if (client.destroyed) return
    if (upgraded) client.destroy()
    else {
      status = 502
      client.end(badGateway)
    }
  })
  upstream.once('response', (response) => {
    const headers = replaceAccountHeader(withoutHopHeaders(requestHeaders(response)), account)
    headers.set('connection', 'close')
    status = response.statusCode ?? 502
    client.write(upgradeResponse(status, headers))
    pipeline(response, client, () => cancel())
  })
  upstream.once('upgrade', (response, socket, upstreamHead) => {
    upgraded = socket
    if (context.signal.aborted || client.destroyed) {
      cleanup()
      return
    }
    if (response.headers.upgrade?.toLowerCase() !== 'websocket') {
      cleanup()
      status = 502
      client.end(badGateway)
      return
    }
    const headers = replaceAccountHeader(withoutHopHeaders(requestHeaders(response)), account)
    headers.set('connection', 'Upgrade')
    headers.set('upgrade', 'websocket')
    status = 101
    client.write(upgradeResponse(status, headers))
    if (upstreamHead.length) client.write(upstreamHead)
    if (head.length) socket.write(head)
    const done = () => {
      client.destroy()
      cleanup()
    }
    pipeline(socket, client, done)
    pipeline(client, socket, done)
  })
  upstream.end()
}

function upgradeResponse(status: number, headers: Headers): string {
  let response = `HTTP/1.1 ${status} ${status === 101 ? 'Switching Protocols' : 'Upstream Response'}\r\n`
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') response += `${name}: ${value}\r\n`
  }
  for (const cookie of headers.getSetCookie()) response += `set-cookie: ${cookie}\r\n`
  return response + '\r\n'
}
