import { expect, test } from 'bun:test'
import { connect, createServer, type Server } from 'node:net'

import { forwarderProgram } from './relay.ts'

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  return address.port
}

async function relay(targetPort: number) {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `
    const { createServer, connect } = require('node:net');
    const target = '127.0.0.1';
    ${forwarderProgram(targetPort)}
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  const port = Number(new TextDecoder().decode(value).trim())
  if (!port) throw new Error('relay did not start')
  return {
    port,
    async stop() {
      proc.kill()
      await proc.exited
    },
  }
}

test('relay preserves a large backpressured request and a response after half-close', async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 91)
  const received: Buffer[] = []
  const upstream = createServer({ allowHalfOpen: true }, (socket) => {
    socket.pause()
    setTimeout(() => socket.resume(), 30)
    socket.on('data', (chunk) => received.push(Buffer.from(chunk)))
    socket.on('end', () => socket.end(Buffer.concat(received)))
  })
  const proxy = await relay(await listen(upstream))
  try {
    const result = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(proxy.port, '127.0.0.1')
      const chunks: Buffer[] = []
      socket.setTimeout(3000, () => socket.destroy(new Error('relay stalled')))
      socket.on('error', reject)
      socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      socket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.end(payload)
    })
    expect(Buffer.concat(received).equals(payload)).toBe(true)
    expect(result.equals(payload)).toBe(true)
  } finally {
    await proxy.stop()
    upstream.close()
  }
})

test('relay closes a refused upstream connection without hanging the client or exiting', async () => {
  const upstream = createServer()
  const port = await listen(upstream)
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  const proxy = await relay(port)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(proxy.port, '127.0.0.1')
        socket.setTimeout(1000, () => reject(new Error('refusal did not close client')))
        socket.on('error', () => {})
        socket.on('close', () => resolve())
        socket.write('request')
      })
    }
  } finally {
    await proxy.stop()
  }
})
