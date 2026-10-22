import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Server } from 'node:net'
import { pipeline, type Duplex } from 'node:stream'
import { createServer as createTlsServer } from 'node:tls'

import { createCertificateAuthority, type CertificateAuthority, type Leaf } from './ca.ts'
import { forward, type ConnectTarget, type ForwardDeps } from './forward.ts'

export type { ForwardDeps, Injection, InjectionInput, UpstreamDestination } from './forward.ts'

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

function rejectConnect(socket: Duplex, status: 400 | 407 | 502): void {
  const reason = { 400: 'Bad Request', 407: 'Proxy Authentication Required', 502: 'Bad Gateway' }[
    status
  ]
  const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="kurumi"\r\n' : ''
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  )
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

export async function startAgentPort<Principal extends object>(deps: {
  bind: { host: string; port: number }
  authenticate(token: string): Principal | null | Promise<Principal | null>
  intercepts(host: string): boolean
  forward: ForwardDeps<Principal>
  ca?: CertificateAuthority
  onConnect?(target: ConnectTarget): void
}): Promise<AgentPort> {
  const ca = deps.ca ?? (await createCertificateAuthority())
  const listeners = new Map<string, Promise<HostListener<Principal>>>()
  const sockets = new Map<Duplex, (() => void) | undefined>()
  let stopping = false
  let stopped: Promise<void> | undefined

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
          void handleRequest(tunnel, req, res).catch(() => {
            if (res.destroyed) return
            if (res.headersSent) res.destroy()
            else res.writeHead(500, { connection: 'close' }).end()
          })
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
    const token = password(req)
    if (token === null || (await deps.authenticate(token)) === null) {
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
    const listener = deps.intercepts(target.host) ? await listenerFor(target.host) : undefined
    if (stopping || client.destroyed) return
    const outbound = connect({
      host: listener ? '127.0.0.1' : target.host,
      port: listener?.port ?? target.port,
    })
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

  const outer = createServer((_req, res) => res.writeHead(404).end())
  outer.on('connection', track)
  outer.on('clientError', (_error, socket) => socket.destroy())
  outer.on('connect', (req, socket, head) => {
    void handleConnect(req, socket, head).catch(() => {
      if (!socket.destroyed) rejectConnect(socket, 502)
    })
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
