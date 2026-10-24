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
