import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type LookupFunction, type Server } from 'node:net'
import { pipeline, type Duplex } from 'node:stream'
import { createServer as createTlsServer } from 'node:tls'

import { addressRefusal, hostAddresses } from './address.ts'
import {
  CaExpiredError,
  createCertificateAuthority,
  type CertificateAuthority,
  type Leaf,
} from './ca.ts'
import { forward, forwardUpgrade, type ConnectTarget, type ForwardDeps } from './forward.ts'
import { nextStep } from './refusal.ts'

type Tunnel<Principal> = {
  target: ConnectTarget
  authenticate(): Principal | null | Promise<Principal | null>
  signal: AbortSignal
}

type HostListener<Principal> = {
  server: ReturnType<typeof createTlsServer>
  port: number
  leaf: Leaf
  pending: Map<string, Tunnel<Principal>>
}

export type AgentPort = {
  port: number
  caPem: string
  stop: () => Promise<void>
}

function parseTarget(value: string): ConnectTarget | null {
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[^\s:/?#@\\]+):\d+$/.test(value)) return null
  try {
    const url = new URL(`https://${value}`)
    const port = Number(value.slice(value.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return null
  }
}

function password(req: IncomingMessage): string | null {
  let count = 0
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'proxy-authorization') count++
  }
  if (count !== 1) return null
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers['proxy-authorization'] ?? '')
  if (!match?.[1]) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon >= 0 && colon < decoded.length - 1 ? decoded.slice(colon + 1) : null
}

function rejectConnect(socket: Duplex, status: 400 | 403 | 407 | 502, body = ''): void {
  const reason = {
    400: 'Bad Request',
    403: 'Forbidden',
    407: 'Proxy Authentication Required',
    502: 'Bad Gateway',
  }[status]
  const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="kurumi"\r\n' : ''
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n${challenge}Connection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy(),
  )
}

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    const [first] = addresses
    if (!first) callback(new Error(`${hostname} resolved to no address`), '')
    else if (options.all) callback(null, addresses)
    else callback(null, first.address, first.family)
  }
}

// A lookup or injection that ignores the abort could otherwise hold stop, and the host's flush and lock release behind it, forever.
const STOP_GRACE_MS = 2_000

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

export async function startAgentPort<Principal extends object>(deps: {
  bind: { host: string; port: number }
  authenticate(token: string): Principal | null | Promise<Principal | null>
  intercepts(host: string): boolean
  addressRefusal?: (address: string, host: readonly string[]) => string | null
  hostAddresses?: () => readonly string[]
  resolve?: (host: string) => Promise<LookupAddress[]>
  forward: ForwardDeps<Principal>
  ca?: CertificateAuthority
  onConnect?(target: ConnectTarget): void
  probeNonce?(): string | null
  stopGraceMs?: number
  rpc?(
    request: IncomingMessage,
    response: ServerResponse,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<void>
}): Promise<AgentPort> {
  const ca = deps.ca ?? (await createCertificateAuthority())
  const refusal = deps.addressRefusal ?? addressRefusal
  const readHostAddresses = deps.hostAddresses ?? hostAddresses
  const resolve = deps.resolve ?? ((host: string) => lookup(host, { all: true }))
  const listeners = new Map<string, Promise<HostListener<Principal>>>()
  const sockets = new Map<Duplex, (() => void) | undefined>()
  const inFlight = new Set<Promise<unknown>>()
  let stopping = false
  let stopped: Promise<void> | undefined

  // stop() waits, up to STOP_GRACE_MS, for every exchange so its egress row is recorded before the caller stops the log.
  function hold(work: Promise<unknown>, closed?: Duplex | ServerResponse): void {
    const done: Promise<unknown> = Promise.allSettled([
      work,
      closed && new Promise((settle) => closed.once('close', settle)),
    ]).then(() => inFlight.delete(done))
    inFlight.add(done)
  }

  function track(socket: Duplex): void {
    sockets.set(socket, undefined)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      const onClose = sockets.get(socket)
      sockets.delete(socket)
      onClose?.()
    })
    if (stopping) socket.destroy()
  }

  async function handleRequest(
    tunnel: Tunnel<Principal>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const principal = await tunnel.authenticate()
    if (res.destroyed || tunnel.signal.aborted) return
    if (principal === null) {
      res
        .writeHead(407, { 'proxy-authenticate': 'Basic realm="kurumi"', connection: 'close' })
        .end()
      return
    }
    await forward(
      { principal, target: tunnel.target, signal: tunnel.signal },
      req,
      res,
      deps.forward,
    )
  }

  async function makeListener(leaf: Leaf): Promise<HostListener<Principal>> {
    const pending = new Map<string, Tunnel<Principal>>()
    const server = createTlsServer(
      {
        key: leaf.keyPem,
        cert: leaf.certPem,
        ALPNProtocols: ['http/1.1'],
        handshakeTimeout: 10_000,
      },
      (socket) => {
        const key = `${socket.remoteAddress}:${socket.remotePort}`
        const tunnel = pending.get(key)
        pending.delete(key)
        track(socket)
        if (!tunnel || tunnel.signal.aborted || stopping) {
          socket.destroy()
          return
        }
        const inner = createServer((req, res) => {
          const handled = handleRequest(tunnel, req, res).catch(() => {
            if (res.destroyed) return
            if (res.headersSent) res.destroy()
            else res.writeHead(500, { connection: 'close' }).end()
          })
          hold(handled, res)
        })
        inner.on('upgrade', (req, client, head) => {
          client.pause()
          const upgraded = (async () => {
            const principal = await tunnel.authenticate()
            if (client.destroyed || tunnel.signal.aborted) return
            if (principal === null) {
              rejectConnect(client, 407)
              return
            }
            await forwardUpgrade(
              { principal, target: tunnel.target, signal: tunnel.signal },
              req,
              client,
              head,
              deps.forward,
            )
          })().catch(() => {
            if (!client.destroyed) rejectConnect(client, 502)
          })
          hold(upgraded, client)
        })
        inner.on('clientError', (_error, client) => client.destroy())
        socket.once('close', () => inner.removeAllListeners())
        inner.emit('connection', socket)
      },
    )
    server.on('connection', track)
    server.on('tlsClientError', (_error, socket) => socket.destroy())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TLS listener has no TCP address')
    return { server, port: address.port, leaf, pending }
  }

  async function listenerFor(host: string): Promise<HostListener<Principal>> {
    const leaf = await ca.leafFor(host)
    if (stopping) throw new Error('Agent Port stopped')
    let pending = listeners.get(host)
    if (!pending) {
      pending = makeListener(leaf)
      listeners.set(host, pending)
      void pending.catch(() => {
        if (listeners.get(host) === pending) listeners.delete(host)
      })
    }
    const listener = await pending
    if (listener.leaf !== leaf) {
      listener.server.setSecureContext({ key: leaf.keyPem, cert: leaf.certPem })
      listener.leaf = leaf
    }
    return listener
  }

  async function handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.pause()
    const aborted = new AbortController()
    sockets.set(client, () => aborted.abort())
    const at = Date.now()
    const started = performance.now()
    const token = password(req)
    const principal = token === null ? null : await deps.authenticate(token)
    if (token === null || principal === null) {
      rejectConnect(client, 407)
      return
    }
    const target = parseTarget(req.url ?? '')
    if (!target) {
      rejectConnect(client, 400)
      return
    }
    if (stopping || client.destroyed) return
    deps.onConnect?.(target)
    const intercepted = deps.intercepts(target.host)
    if (intercepted && target.port !== 443) {
      rejectConnect(
        client,
        403,
        `${nextStep({ code: 'port_not_allowed', host: target.host, port: target.port })}\n`,
      )
      deps.forward.log?.({
        decision: 'refused',
        refusal: 'port_not_allowed',
        service: null,
        principal,
        at,
        host: target.host,
        method: 'CONNECT',
        path: req.url ?? '',
        status: 403,
        durationMs: Math.round(performance.now() - started),
      })
      return
    }
    const listener = intercepted ? await listenerFor(target.host) : undefined
    const addresses = listener ? [] : await resolve(target.host)
    const host = listener ? [] : readHostAddresses()
    const reason = addresses
      .map(({ address }) => refusal(address, host))
      .find((found) => found !== null)
    if (reason) {
      rejectConnect(
        client,
        403,
        `kurumi refuses to tunnel to ${target.host}: it resolves to a ${reason} address\n`,
      )
      deps.forward.log?.({
        decision: 'refused',
        refusal: 'upstream_not_public',
        service: null,
        principal,
        at,
        host: target.host,
        method: 'CONNECT',
        path: req.url ?? '',
        status: 403,
        durationMs: Math.round(performance.now() - started),
      })
      return
    }
    if (stopping || client.destroyed) return
    const outbound = connect(
      listener
        ? { host: '127.0.0.1', port: listener.port }
        : { host: target.host, port: target.port, lookup: pinnedLookup(addresses) },
    )
    track(outbound)
    const cancel = () => outbound.destroy()
    aborted.signal.addEventListener('abort', cancel, { once: true })
    outbound.once('close', () => aborted.signal.removeEventListener('abort', cancel))
    await once(outbound, 'connect', { signal: aborted.signal })
    if (stopping || client.destroyed) {
      outbound.destroy()
      return
    }
    if (listener) {
      if (outbound.localPort === undefined || outbound.localAddress === undefined) {
        throw new Error('Loopback connection has no TCP address')
      }
      const key = `${outbound.localAddress}:${outbound.localPort}`
      const tunnel: Tunnel<Principal> = {
        target,
        authenticate: () => deps.authenticate(token),
        signal: aborted.signal,
      }
      listener.pending.set(key, tunnel)
      outbound.once('close', () => {
        if (listener.pending.get(key) === tunnel) listener.pending.delete(key)
      })
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) outbound.write(head)
    const done = (error: NodeJS.ErrnoException | null) => {
      if (error) {
        client.destroy()
        outbound.destroy()
      }
    }
    pipeline(client, outbound, client, done)
  }

  async function handleOuter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = deps.probeNonce?.()
    if (req.method === 'GET' && nonce && req.url === `/probe/${nonce}`) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(nonce)
      return
    }
    if (!deps.rpc) {
      res.writeHead(404).end()
      return
    }
    let count = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'authorization') count++
    }
    const token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const principal = count === 1 && token ? await deps.authenticate(token) : null
    if (principal === null) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
      return
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    if (res.destroyed || stopping) controller.abort()
    try {
      await deps.rpc(req, res, principal, controller.signal)
    } finally {
      res.removeListener('close', abort)
    }
  }

  const outer = createServer((req, res) => {
    handleOuter(req, res).catch(() => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else res.writeHead(500).end()
    })
  })
  outer.on('connection', track)
  outer.on('clientError', (_error, socket) => socket.destroy())
  outer.on('connect', (req, socket, head) => {
    const connected = handleConnect(req, socket, head).catch((error: unknown) => {
      if (socket.destroyed) return
      rejectConnect(socket, 502, error instanceof CaExpiredError ? `${error.message}\n` : '')
    })
    hold(connected)
  })

  function stop(): Promise<void> {
    stopped ??= (async () => {
      stopping = true
      const outerClosed = closeServer(outer)
      for (const socket of sockets.keys()) socket.destroy()
      const ready = await Promise.allSettled(listeners.values())
      await Promise.all(
        ready.map(async (result) => {
          if (result.status === 'fulfilled') {
            result.value.pending.clear()
            await closeServer(result.value.server)
          }
        }),
      )
      listeners.clear()
      await outerClosed
      let grace: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(inFlight),
        new Promise((expire) => {
          grace = setTimeout(expire, deps.stopGraceMs ?? STOP_GRACE_MS)
        }),
      ])
      clearTimeout(grace)
    })()
    return stopped
  }

  try {
    outer.listen(deps.bind.port, deps.bind.host)
    await once(outer, 'listening')
  } catch (error) {
    await stop()
    throw error
  }
  const address = outer.address()
  if (!address || typeof address === 'string') throw new Error('Agent Port has no TCP address')
  return { port: address.port, caPem: ca.certPem, stop }
}
