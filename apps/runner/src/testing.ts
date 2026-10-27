import { Database } from 'bun:sqlite'
import { expect, mock } from 'bun:test'
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
import { createSessionLedger, migrations, router } from '@kurumi/session/server'
import { createFakeDriver } from '@kurumi/session/testing'
import { RPCHandler } from '@orpc/server/node'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

export type FakeCall = { prompt: string; resume: string | null; signal: AbortSignal }

const sessions = new Map<string, string[]>()

function remembering(call: FakeCall): AsyncGenerator<object> {
  return (async function* () {
    if (call.resume !== null && !sessions.has(call.resume)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: call.resume,
        errors: [`No conversation found with session ID: ${call.resume}`],
      }
      throw new Error('Claude Code returned an error result')
    }
    const session = call.resume ?? crypto.randomUUID()
    const history = [...(sessions.get(session) ?? []), call.prompt]
    sessions.set(session, history)
    yield { type: 'system', subtype: 'init', session_id: session }
    yield sdk.assistant(`model heard: ${history.join(' | ')}`)
    yield sdk.success(session)
  })()
}

export const sdk = {
  calls: [] as FakeCall[],
  respond: remembering,
  forget: () => sessions.clear(),
  reset() {
    sdk.calls.length = 0
    sdk.respond = remembering
    sessions.clear()
  },
  assistant: (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }),
  success: (session: string) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    api_error_status: null,
    session_id: session,
  }),
}

const realSdk = await import('@anthropic-ai/claude-agent-sdk')

await mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query({
    prompt,
    options,
  }: {
    prompt: string
    options: { resume?: string; abortController: AbortController }
  }) {
    const call = { prompt, resume: options.resume ?? null, signal: options.abortController.signal }
    sdk.calls.push(call)
    return sdk.respond(call)
  },
}))

export async function startHost() {
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
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      paths.push(pathname)
      if (unavailable) return new Response('restarting', { status: 503 })
      const response = await fetch(`http://127.0.0.1:${port.port}${pathname}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      })
      if (losePostAck && pathname.endsWith('/post')) {
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
    latestToken: () => driver.runs.at(-1)?.env.KURUMI_TOKEN ?? '',
    input,
    paths,
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
    async reply(): Promise<string | null> {
      const { value } = await input.next()
      return value && 'text' in value ? value.text : null
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
