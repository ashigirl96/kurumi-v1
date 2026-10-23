import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request, type RequestOptions } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { PassThrough, pipeline, type Duplex } from 'node:stream'

import type { AccountHandle, AccountLedger, CredentialPrincipal } from '@kurumi/account/server'

import { addressRefusal, hostAddresses } from './address.ts'
import { refusalHttp, refusalResponse, type GatewayRefusal } from './refusal.ts'

export type ConnectTarget = { host: string; port: number }

export type InjectionInput<Principal> = ConnectTarget & {
  principal: Principal
  method: string
  path: string
  headers: Headers
  rawHeaders: readonly string[]
}

export type Forwarded = { path: string; headers: Headers; account?: AccountHandle }

type Injected = Forwarded | { refusal: GatewayRefusal }

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
  return ({ principal, host, path, headers, rawHeaders }) => {
    const decision = ledger.credentialFor(principal, { host, path, headers, rawHeaders })
    switch (decision.kind) {
      case 'inject':
        return { ...decision.injection.apply(), account: decision.injection.handle }
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
  headers.delete('x-kurumi-account')
  if (account !== undefined) headers.set('x-kurumi-account', encodeURI(account.toWellFormed()))
  return headers
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
    }
  | { kind: 'bad_request' }
  | { kind: 'refused'; refusal: GatewayRefusal }
  | { kind: 'unreachable' }

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
  if ('refusal' in injected) return { kind: 'refused', refusal: injected.refusal }
  const destination = deps.upstream?.host === target.host ? deps.upstream : undefined
  const pinned = destination ? undefined : await pinPublicUpstream(target.host, deps)
  if (pinned && pinned.kind !== 'pinned') return pinned
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
    account: injected.account,
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
  const prepared = await prepareRequest(context, req, deps)
  if (context.signal.aborted || res.destroyed) return
  if (prepared.kind === 'bad_request') {
    res.writeHead(400, { connection: 'close' }).end()
    return
  }
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
  const prepared = await prepareRequest(context, req, deps)
  if (context.signal.aborted || client.destroyed) return
  if (prepared.kind === 'bad_request') {
    client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  if (prepared.kind === 'refused') {
    client.end(refusalHttp(prepared.refusal))
    return
  }
  if (prepared.kind === 'unreachable') {
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
    else client.end(badGateway)
  })
  upstream.once('response', (response) => {
    const headers = replaceAccountHeader(withoutHopHeaders(requestHeaders(response)), account)
    headers.set('connection', 'close')
    client.write(upgradeResponse(response.statusCode ?? 502, headers))
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
      client.end(badGateway)
      return
    }
    const headers = replaceAccountHeader(withoutHopHeaders(requestHeaders(response)), account)
    headers.set('connection', 'Upgrade')
    headers.set('upgrade', 'websocket')
    client.write(upgradeResponse(101, headers))
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
