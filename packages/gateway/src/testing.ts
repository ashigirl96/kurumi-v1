import { createHash, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http'
import { Agent, createServer, request } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { pipeline, Readable } from 'node:stream'
import { connect, type TLSSocket } from 'node:tls'

import { createCertificateAuthority, type CertificateAuthority } from './ca.ts'
import { authority, type ConnectTarget, type UpstreamDestination } from './forward.ts'
import { startAgentPort } from './port.ts'

export { createCertificateAuthority } from './ca.ts'

type ReceivedRequest = {
  method: string
  path: string
  headers: IncomingHttpHeaders
  rawHeaders: readonly string[]
  body:
    | { kind: 'receiving'; bytes: number }
    | { kind: 'complete'; bytes: number; sha256: string }
    | { kind: 'aborted'; bytes: number }
}

type FakeResponse = { status: number; body: string; headers?: OutgoingHttpHeaders }

export async function startFakeUpstream({
  host = 'fake.test',
  port = 0,
  bindHost = '127.0.0.1',
  ca: suppliedCa,
  onUploadChunk,
}: {
  host?: string
  port?: number
  bindHost?: string
  ca?: CertificateAuthority
  onUploadChunk?: (chunk: Uint8Array) => void
} = {}) {
  const ca = suppliedCa ?? (await createCertificateAuthority())
  const leaf = await ca.leafFor(host)
  const requests: ReceivedRequest[] = []
  const responses = new Map<string, FakeResponse>()
  const sockets = new Set<Socket>()
  const server = createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const entry: ReceivedRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      rawHeaders: [...req.rawHeaders],
      body: { kind: 'receiving', bytes: 0 },
    }
    requests.push(entry)
    const hash = createHash('sha256')
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      hash.update(chunk)
      entry.body = { kind: 'receiving', bytes }
      if (entry.path.startsWith('/upload')) onUploadChunk?.(chunk)
    })
    req.on('error', () => {
      entry.body = { kind: 'aborted', bytes }
      res.destroy()
    })
    req.on('end', () => {
      const sha256 = hash.digest('hex')
      entry.body = { kind: 'complete', bytes, sha256 }
      const url = new URL(entry.path, `https://${host}`)
      const configured = responses.get(url.pathname)
      if (configured) {
        res.writeHead(configured.status, configured.headers).end(configured.body)
      } else if (url.pathname === '/upload') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ bytes, sha256 }))
      } else if (url.pathname === '/chunked') {
        const total = Number(url.searchParams.get('bytes') ?? 1024 * 1024)
        if (!Number.isSafeInteger(total) || total < 0) {
          res.writeHead(400).end()
          return
        }
        function* chunks() {
          const chunk = Buffer.alloc(64 * 1024, 120)
          for (let sent = 0; sent < total; sent += chunk.length) {
            yield chunk.subarray(0, Math.min(chunk.length, total - sent))
          }
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        pipeline(Readable.from(chunks()), res, (error) => {
          if (error) res.destroy()
        })
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            method: entry.method,
            path: entry.path,
            headers: entry.headers,
          }),
        )
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('tlsClientError', (_error, socket) => socket.destroy())
  server.listen(port, bindHost)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake upstream has no TCP address')
  let stopped: Promise<void> | undefined
  const stop = () => {
    stopped ??= new Promise<void>((resolve) => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    })
    return stopped
  }
  return {
    host,
    port: address.port,
    caPem: ca.certPem,
    certificate: new X509Certificate(leaf.certPem),
    destination: {
      host,
      address: '127.0.0.1',
      port: address.port,
      caPem: ca.certPem,
    } satisfies UpstreamDestination,
    requests,
    stop,
    setResponse: (path: string, response: FakeResponse) => {
      responses.set(path, response)
    },
  }
}

export async function startTestGateway({
  port,
  token,
  intercepts,
  upstream,
  bindHost = '0.0.0.0',
}: {
  port: number
  token: string
  intercepts: ReadonlySet<string>
  upstream?: UpstreamDestination
  bindHost?: string
}) {
  const connects: ConnectTarget[] = []
  const gateway = await startAgentPort({
    bind: { host: bindHost, port },
    authenticate: (password) =>
      password === token ? { sessionId: 'test-session', agentGroupId: 'test-group' } : null,
    intercepts: (host) => intercepts.has(host),
    onConnect: (target) => {
      connects.push(target)
    },
    forward: {
      upstream,
      inject: ({ path, headers }) => {
        headers.set('x-injected', 'yes')
        return { path, headers }
      },
    },
  })
  console.info(JSON.stringify({ event: 'gateway.started', pid: process.pid, port: gateway.port }))
  return { ...gateway, pid: process.pid, connects }
}

type TestTunnel = { target: ConnectTarget; socket: TLSSocket; agent: Agent; close: () => void }

export async function openTestTunnel({
  proxyPort,
  token,
  caPem,
  target = { host: 'fake.test', port: 443 },
}: {
  proxyPort: number
  token: string
  caPem: string
  target?: ConnectTarget
}): Promise<TestTunnel> {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`,
      headers: { 'proxy-authorization': `Basic ${Buffer.from(`s:${token}`).toString('base64')}` },
    })
    req.on('error', reject)
    req.on('connect', (response, raw, head) => {
      if (response.statusCode !== 200) {
        raw.destroy()
        reject(new Error(`CONNECT returned ${response.statusCode}`))
        return
      }
      if (head.length) raw.unshift(head)
      const secure = connect({
        socket: raw,
        host: target.host,
        ca: caPem,
        servername: isIP(target.host) ? undefined : target.host,
        ALPNProtocols: ['http/1.1'],
      })
      secure.once('error', reject)
      secure.once('secureConnect', () => resolve(secure))
    })
    req.end()
  })
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  agent.createConnection = () => socket
  return {
    target,
    socket,
    agent,
    close: () => {
      agent.destroy()
      socket.destroy()
    },
  }
}

export function sendTestRequest(
  tunnel: TestTunnel,
  input: {
    path: string
    method?: string
    headers?: OutgoingHttpHeaders
    body?: string
  },
): Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: tunnel.target.host,
        port: tunnel.target.port,
        agent: tunnel.agent,
        path: input.path,
        method: input.method ?? 'GET',
        headers: { host: authority(tunnel.target), ...input.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(input.body)
  })
}
