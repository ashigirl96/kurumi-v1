import { afterEach, expect, test } from 'bun:test'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  openTestTunnel,
  sendTestRequest,
  startFakeStreamUpstream,
  startTestGateway,
} from './testing.ts'

const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
})

async function setup() {
  const upstream = await startFakeStreamUpstream()
  stops.push(upstream.stop)
  const gateway = await startTestGateway({
    port: 0,
    token: 'test-token',
    intercepts: new Set(['fake.test']),
    upstream: upstream.destination,
  })
  stops.push(gateway.stop)
  const tunnel = await openTestTunnel({
    proxyPort: gateway.port,
    token: 'test-token',
    caPem: gateway.caPem,
  })
  stops.push(tunnel.close)
  return { upstream, gateway, tunnel }
}

test('a paused SSE reader keeps the byte gap within 32 MiB and then receives all 200 MiB', async () => {
  const { upstream, tunnel } = await setup()
  const total = 200 * 1024 * 1024
  const client = request({
    hostname: 'fake.test',
    path: `/sse?bytes=${total}`,
    agent: tunnel.agent,
  })
  stops.push(() => {
    client.destroy()
  })
  const response = once(client, 'response')
  client.end()
  const [res] = await response
  let received = 0
  res.on('data', (chunk: Buffer) => {
    received += chunk.length
  })
  res.pause()
  for (let sample = 0; sample < 20; sample++) {
    await delay(100)
    expect(upstream.streams[0]!.written).toBeGreaterThan(0)
    expect(upstream.streams[0]!.written - received).toBeLessThanOrEqual(32 * 1024 * 1024)
  }
  const ended = once(res, 'end')
  res.resume()
  await ended
  expect(received).toBe(total)
  expect(upstream.streams[0]!.written).toBe(total)
}, 15_000)

test('aborting an SSE client closes the upstream stream', async () => {
  const { upstream, tunnel } = await setup()
  const client = request({ hostname: 'fake.test', path: '/sse', agent: tunnel.agent })
  const response = once(client, 'response')
  client.end()
  const [res] = await response
  res.on('error', () => {})
  await once(res, 'data')
  tunnel.close()
  for (let attempt = 0; attempt < 100 && !upstream.streams[0]?.closed; attempt++) await delay(10)
  expect(upstream.streams[0]?.closed).toBe(true)
})

test('a silent SSE stream delivers its event and a recorded body is replayed exactly', async () => {
  const { upstream, tunnel } = await setup()
  expect((await sendTestRequest(tunnel, { path: '/sse-idle?ms=100' })).body).toBe('data: awake\n\n')
  const body =
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  upstream.setSseResponse('/recorded', body)
  const replay = await sendTestRequest(tunnel, { path: '/recorded' })
  expect(replay.headers['content-type']).toBe('text/event-stream')
  expect(replay.body).toBe(body)
})

test.each(['--http2', '--http2-prior-knowledge'])(
  'curl %s negotiates HTTP/1.1 through MITM',
  async (flag) => {
    const { gateway } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'kurumi-alpn-'))
    stops.push(() => rm(dir, { recursive: true, force: true }))
    const caPath = join(dir, 'ca.pem')
    await writeFile(caPath, gateway.caPem)
    const child = Bun.spawn(
      [
        '/usr/bin/curl',
        flag,
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--noproxy',
        '',
        '--proxy',
        `http://s:test-token@127.0.0.1:${gateway.port}`,
        '--cacert',
        caPath,
        '--write-out',
        '\n%{http_code} %{http_version}',
        'https://fake.test/echo',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, error }).toEqual({ code: 0, error: '' })
    expect(output).toContain('"x-injected":"yes"')
    expect(output).toEndWith('\n200 1.1')
  },
)
