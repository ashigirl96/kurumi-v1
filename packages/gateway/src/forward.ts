import type { IncomingMessage, ServerResponse } from 'node:http'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { PassThrough, pipeline } from 'node:stream'

export type ConnectTarget = { host: string; port: number }

export type InjectionInput<Principal> = ConnectTarget & {
  principal: Principal
  method: string
  path: string
  headers: Headers
  rawHeaders: readonly string[]
}

export type Injection = { path: string; headers: Headers }

export type UpstreamDestination = {
  host: string
  address: string
  port?: number
  caPem: string
}

export type ForwardDeps<Principal> = {
  inject(input: InjectionInput<Principal>): Injection | Promise<Injection>
  upstream?: UpstreamDestination
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

export async function forward<Principal>(
  context: { principal: Principal; target: ConnectTarget; signal: AbortSignal },
  req: IncomingMessage,
  res: ServerResponse,
  deps: ForwardDeps<Principal>,
): Promise<void> {
  const { target } = context
  const path = req.url ?? '/'
  const host = req.headers.host?.toLowerCase()
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    !host ||
    (host !== authority(target) && !(target.port === 443 && host === `${authority(target)}:443`))
  ) {
    res.writeHead(400, { connection: 'close' }).end()
    return
  }
  const injection = await deps.inject({
    principal: context.principal,
    ...target,
    method: req.method ?? 'GET',
    path,
    headers: requestHeaders(req),
    rawHeaders: [...req.rawHeaders],
  })
  if (context.signal.aborted || res.destroyed) return
  const headers = withoutHopHeaders(injection.headers)
  headers.set('host', authority(target))
  const destination = deps.upstream?.host === target.host ? deps.upstream : undefined
  const body = new PassThrough()
  const upstream = request({
    hostname: destination?.address ?? target.host,
    port: destination?.port ?? target.port,
    servername: isIP(target.host) ? undefined : target.host,
    ca: destination?.caPem,
    method: req.method,
    path: injection.path,
    headers: Object.fromEntries(headers),
    agent: false,
  })

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
    res.writeHead(502, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: 'upstream_unreachable', host: target.host }))
  })
  upstream.once('response', (response) => {
    const responseHeaders = withoutHopHeaders(requestHeaders(response))
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
