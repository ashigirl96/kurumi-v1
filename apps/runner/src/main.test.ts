import { afterEach, expect, test } from 'bun:test'

import { inboundMessage, outboundMessage } from '@kurumi/session/schema'

import { runRunner } from './main.ts'
import { sdk, startHost } from './testing.ts'

afterEach(() => sdk.reset())

test('runner answers through an in-process host and completes ten lines in order', async () => {
  const host = await startHost()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    expect(sdk.calls[0]?.mcpServers?.kurumi).toMatchObject({ name: 'kurumi', type: 'sdk' })
    for (let i = 0; i < 10; i++) await host.send(`line ${i}`)
    const replies = []
    for (let i = 0; i < 10; i++) replies.push(await host.reply())
    expect(replies.map((reply) => reply?.split(' | ').at(-1))).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${i}`),
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
  const host = await startHost()
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
  const host = await startHost()
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
    expect(await host.reply()).toBe('model heard: hello')
    await retried.promise
    await host.send('after reconnect')
    expect(await host.reply()).toBe('model heard: hello | after reconnect')
    expect(host.db.select().from(outboundMessage).all()).toHaveLength(2)
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('runner did not reach the expected state')
    await Bun.sleep(5)
  }
}

test('offline replies stop retrying, preserve every reply and later continuation, and unblock the next inbound', async () => {
  const host = await startHost()
  await host.input.return()
  sdk.respond = (call) =>
    (async function* () {
      if (call.prompt === 'hello') {
        yield sdk.assistant('first offline reply')
        yield sdk.assistant('second offline reply')
        yield { type: 'system', subtype: 'init', session_id: 'saved-after-replies' }
      } else yield sdk.assistant(`resumed ${call.resume}`)
      yield sdk.success('saved-after-replies')
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  let connected: ReturnType<typeof host.connect> | undefined
  try {
    await waitFor(() => host.db.select().from(inboundMessage).all()[0]?.status === 'failed', 26000)
    const offline = host.db.select().from(outboundMessage).all()
    expect(offline.map((row) => [row.content, row.status, row.attempts])).toEqual([
      ['first offline reply', 'failed', 8],
      ['second offline reply', 'failed', 8],
    ])
    await Bun.sleep(150)
    expect(host.db.select().from(outboundMessage).all()).toEqual(offline)
    connected = host.connect('next inbound')
    expect((await connected.next()).value).toMatchObject({ kind: 'queued' })
    expect((await connected.next()).value).toMatchObject({ text: 'first offline reply' })
    expect((await connected.next()).value).toMatchObject({ text: 'second offline reply' })
    expect((await connected.next()).value).toMatchObject({ text: 'resumed saved-after-replies' })
    await waitFor(() => host.db.select().from(inboundMessage).all()[1]?.status === 'completed')
    expect(
      host.db
        .select()
        .from(inboundMessage)
        .all()
        .map((row) => row.status),
    ).toEqual(['failed', 'completed'])
    expect(
      host.db
        .select()
        .from(outboundMessage)
        .all()
        .every((row) => row.status === 'delivered'),
    ).toBe(true)
  } finally {
    controller.abort()
    await running
    await connected?.return()
    await host.stop()
  }
}, 30000)

test('a terminal reconnect before the cap delivers the original reply once and completes both inbounds', async () => {
  const host = await startHost()
  await host.input.return()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  const connected = host.connect('reconnected')
  try {
    await waitFor(() => host.db.select().from(outboundMessage).all()[0]?.status === 'failed')
    await connected.next()
    expect((await connected.next()).value).toMatchObject({ text: 'model heard: hello' })
    expect((await connected.next()).value).toMatchObject({
      text: 'model heard: hello | reconnected',
    })
    await waitFor(() =>
      host.db
        .select()
        .from(inboundMessage)
        .all()
        .every((row) => row.status === 'completed'),
    )
    expect(host.db.select().from(outboundMessage).all()).toHaveLength(2)
  } finally {
    controller.abort()
    await running
    await connected.return()
    await host.stop()
  }
})

test('abort during disconnected delivery leaves accepted work failed and its inbound recoverable', async () => {
  const host = await startHost()
  await host.input.return()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    await waitFor(() => host.db.select().from(outboundMessage).all()[0]?.status === 'failed')
    controller.abort()
    await running
    expect(host.db.select().from(inboundMessage).all()[0]?.status).toBe('processing')
    expect(host.db.select().from(outboundMessage).all()[0]?.status).toBe('failed')
    await host.revoke()
    await waitFor(() => host.db.select().from(inboundMessage).all()[0]?.status === 'pending')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})
