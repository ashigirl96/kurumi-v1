import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createAgentLedger,
  migrations as agentMigrations,
  router as agentRouter,
} from '@kurumi/agent/server'
import { createChatLedger, migrations as chatMigrations } from '@kurumi/chat/server'
import { startAgentPort } from '@kurumi/gateway/server'
import { guardRouter, type KurumiContext } from '@kurumi/rpc/server'
import { inboundMessage, outboundMessage } from '@kurumi/session/schema'
import { createSessionLedger, migrations, router } from '@kurumi/session/server'
import { createFakeDriver } from '@kurumi/session/testing'
import { RPCHandler } from '@orpc/server/node'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { runRunner } from './main.ts'

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'kurumi-runner-'))
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const entry of [agentMigrations, chatMigrations, migrations]) {
    migrate(db, { migrationsFolder: entry.folder, migrationsTable: entry.table })
  }
  const agentLedger = createAgentLedger({ db, home })
  const agent = agentLedger.create({ name: 'work' })
  const driver = createFakeDriver()
  const chatLedger = createChatLedger({
    db,
    agentLedger,
    sink: () => ({ onInbound: (event) => sessionLedger.routeInbound(event) }),
  })
  const sessionLedger = createSessionLedger({
    db,
    agentLedger,
    chatLedger,
    runtime: {
      driver,
      image: 'test',
      egress: {
        admission: () => ({ open: true }),
        contribution: () => ({ env: {}, mounts: [], network: { kind: 'default' } }),
      },
    },
  })
  type Context = KurumiContext & {
    agentLedger: typeof agentLedger
    sessionLedger: typeof sessionLedger
    agentPrincipal: ReturnType<typeof sessionLedger.authenticate>
    requestSignal: AbortSignal
  }
  const handler = new RPCHandler(
    guardRouter<Context>().router({ session: router, agent: agentRouter }),
  )
  const port = await startAgentPort({
    bind: { host: '127.0.0.1', port: 0 },
    authenticate: (token) => sessionLedger.authenticate(token),
    intercepts: () => false,
    forward: { inject: ({ path, headers }) => ({ path, headers }) },
    async rpc(request, response, principal, signal) {
      const result = await handler.handle(request, response, {
        prefix: '/rpc',
        context: {
          db,
          agentLedger,
          sessionLedger,
          caller: { kind: 'agent', ...principal },
          agentPrincipal: principal,
          requestSignal: signal,
          grant: null,
          guard: ({ meta }) =>
            meta.agent === 'channel' ? { kind: 'allow' } : { kind: 'deny', reason: 'channel only' },
        },
      })
      if (!result.matched) response.writeHead(404).end()
    },
  })
  let unavailable = false
  let losePostAck = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (unavailable) return new Response('restarting', { status: 503 })
      const response = await fetch(
        `http://127.0.0.1:${port.port}${new URL(request.url).pathname}`,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
        },
      )
      if (losePostAck && new URL(request.url).pathname.endsWith('/post')) {
        losePostAck = false
        await response.body?.cancel()
        return new Response('lost acknowledgment', { status: 503 })
      }
      return response
    },
  })
  const input = chatLedger.terminal({ agentGroupId: agent.id, text: 'hello', follow: true })
  const queued = await input.next()
  expect(queued.value).toMatchObject({ kind: 'queued' })
  const token = driver.runs[0]?.env.KURUMI_TOKEN
  if (!token) throw new Error('missing runner token')
  return {
    db,
    url: server.url.href.replace(/\/$/, ''),
    token,
    input,
    revoke: () => driver.kill(driver.runs[0]?.containerId ?? '', 0),
    setUnavailable(value: boolean) {
      unavailable = value
    },
    losePostAck() {
      losePostAck = true
    },
    async send(text: string) {
      const events = chatLedger.terminal({ agentGroupId: agent.id, text, follow: false })
      await events.next()
      await events.return()
    },
    async stop() {
      chatLedger.stop()
      await sessionLedger.stop()
      await server.stop(true)
      await port.stop()
      sqlite.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('runner echoes through an in-process host and completes ten lines in order', async () => {
  const host = await fixture()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect((await host.input.next()).value).toMatchObject({ kind: 'reply', text: 'echo: hello' })
    for (let i = 0; i < 10; i++) await host.send(`line ${i}`)
    const replies = []
    for (let i = 0; i < 10; i++) replies.push((await host.input.next()).value)
    expect(replies.map((reply) => (reply && 'text' in reply ? reply.text : null))).toEqual(
      Array.from({ length: 10 }, (_, i) => `echo: line ${i}`),
    )
    const deadline = performance.now() + 1000
    while (
      host.db
        .select()
        .from(inboundMessage)
        .all()
        .some((row) => row.status !== 'completed')
    ) {
      if (performance.now() > deadline) throw new Error('runner did not complete its claims')
      await Bun.sleep(5)
    }
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('Agent Port refuses wrong and revoked tokens, cross-session input, and agent.list', async () => {
  const host = await fixture()
  const request = (path: string, token: string, input: unknown) =>
    fetch(`${host.url}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    })
  try {
    expect((await request('session/channel/pull', 'wrong', { waitMs: 0 })).status).toBe(401)
    expect(
      (await request('session/channel/pull', host.token, { waitMs: 0, sessionId: 'ses-other' }))
        .status,
    ).toBe(400)
    const forbidden = await request('agent/list', host.token, null)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).toContain('FORBIDDEN')
    expect((await request('session/channel/pull', host.token, { waitMs: 0 })).status).toBe(200)
    await host.revoke()
    expect((await request('session/channel/pull', host.token, { waitMs: 0 })).status).toBe(401)
  } finally {
    await host.stop()
  }
})

test('runner reconnects and retries an unacknowledged post without a second delivery', async () => {
  const host = await fixture()
  const controller = new AbortController()
  host.setUnavailable(true)
  host.losePostAck()
  const retried = Promise.withResolvers<void>()
  let retries = 0
  const running = runRunner({
    url: host.url,
    token: host.token,
    signal: controller.signal,
    onRetry() {
      retries++
      host.setUnavailable(false)
      if (retries >= 2) retried.resolve()
    },
  })
  try {
    expect((await host.input.next()).value).toMatchObject({ kind: 'reply', text: 'echo: hello' })
    await retried.promise
    await host.send('after reconnect')
    expect((await host.input.next()).value).toMatchObject({
      kind: 'reply',
      text: 'echo: after reconnect',
    })
    expect(host.db.select().from(outboundMessage).all()).toHaveLength(2)
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})
