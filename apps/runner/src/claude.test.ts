import { afterEach, expect, test } from 'bun:test'

import { inboundMessage, outboundMessage } from '@kurumi/session/schema'

import { runRunner } from './main.ts'
import { type FakeCall, sdk, startHost } from './testing.ts'

afterEach(() => sdk.reset())

const refusalNext =
  'anthropic/other is not granted anthropic-api for this agent group; put kurumi:<handle> for one of anthropic/main where the token goes'
const refusalText = `Failed to authenticate. API Error: 403 ${JSON.stringify({
  error: 'account_not_granted',
  service: 'anthropic-api',
  named: 'anthropic/other',
  granted: ['anthropic/main'],
  next: refusalNext,
})}`

function untilAborted(call: FakeCall): Promise<never> {
  return new Promise((_, reject) =>
    call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
  )
}

const allCompleted = (host: Awaited<ReturnType<typeof startHost>>) => () =>
  host.db
    .select()
    .from(inboundMessage)
    .all()
    .every((row) => row.status === 'completed')

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 2000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

test('a new runner resumes the conversation from the continuation the host saved', async () => {
  const host = await startHost()
  const first = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: first.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    await host.send('my name is lane3')
    expect(await host.reply()).toContain('lane3')
    await waitFor(allCompleted(host), 'the first runner to complete its lines')
    first.abort()
    await running

    const second = new AbortController()
    const replacement = runRunner({ url: host.url, token: host.token, signal: second.signal })
    await host.send('what is my name')
    expect(await host.reply()).toBe('model heard: hello | my name is lane3 | what is my name')
    second.abort()
    await replacement
  } finally {
    first.abort()
    await host.stop()
  }
})

test('a lost transcript starts a fresh conversation instead of failing every turn', async () => {
  const host = await startHost()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    sdk.forget()
    await host.send('still there')
    expect(await host.reply()).toBe('model heard: still there')
    await host.send('and again')
    expect(await host.reply()).toBe('model heard: still there | and again')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('a line completes and the next one runs while Claude Code is still exiting', async () => {
  const host = await startHost()
  const answer = sdk.respond
  sdk.respond = (call) =>
    (async function* () {
      yield* answer(call)
      yield { type: 'system', subtype: 'init', session_id: 'ses-stale' }
      await untilAborted(call)
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    await waitFor(allCompleted(host), 'the line to complete before Claude Code exits')
    await host.send('next')
    expect(await host.reply()).toBe('model heard: hello | next')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('runner heartbeats while a turn runs and stops when it ends', async () => {
  const host = await startHost()
  const release = Promise.withResolvers<void>()
  sdk.respond = (call) =>
    (async function* () {
      await release.promise
      yield sdk.assistant(`late answer to ${call.prompt}`)
      yield sdk.success('ses-heartbeat')
    })()
  const heartbeats = () => host.paths.filter((path) => path.endsWith('/heartbeat')).length
  const controller = new AbortController()
  const running = runRunner({
    url: host.url,
    token: host.token,
    signal: controller.signal,
    heartbeatMs: 20,
  })
  try {
    await waitFor(() => heartbeats() >= 3, 'three heartbeats during one turn')
    release.resolve()
    expect(await host.reply()).toBe('late answer to hello')
    const afterTurn = heartbeats()
    await Bun.sleep(100)
    expect(heartbeats()).toBe(afterTurn)
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('a provider refusal posts a notice with its status and next step, and the runner stays up', async () => {
  const host = await startHost()
  sdk.respond = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'ses-refused' }
      yield {
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: refusalText }] },
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: refusalText,
        api_error_status: 403,
        session_id: 'ses-refused',
      }
      throw new Error(`Claude Code returned an error result: ${refusalText}`)
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe(`Provider error 403 account_not_granted: ${refusalNext}`)
    sdk.respond = () =>
      (async function* () {
        yield* []
        throw new Error('Claude Code executable not found')
      })()
    await host.send('again')
    expect(await host.reply()).toBe('Provider error: Claude Code executable not found')
    sdk.reset()
    await host.send('recovered')
    expect(await host.reply()).toBe('model heard: recovered')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

async function loseRunnerMidTurn(host: Awaited<ReturnType<typeof startHost>>, replies: string[]) {
  const controller = new AbortController()
  const lost = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  for (const reply of replies) expect(await host.reply()).toBe(reply)
  await host.revoke()
  controller.abort()
  await lost
}

test('a re-run turn keeps the replies its lost run posted and adds its own after them', async () => {
  const host = await startHost()
  sdk.respond = (call) =>
    (async function* () {
      yield sdk.assistant('first draft')
      yield sdk.assistant('Let me check first.')
      await untilAborted(call)
    })()
  const controller = new AbortController()
  try {
    await loseRunnerMidTurn(host, ['first draft', 'Let me check first.'])

    sdk.respond = (call) =>
      (async function* () {
        if (call.prompt === 'hello') {
          yield sdk.assistant('first draft')
          yield sdk.assistant('The answer is 42.')
        } else yield sdk.assistant(`answer to ${call.prompt}`)
        yield sdk.success('ses-rerun')
      })()
    await host.send('next')
    const replacement = runRunner({
      url: host.url,
      token: host.latestToken(),
      signal: controller.signal,
    })
    expect(await host.reply()).toBe('The answer is 42.')
    expect(await host.reply()).toBe('answer to next')
    expect(
      host.db
        .select()
        .from(outboundMessage)
        .all()
        .map((row) => row.content),
    ).toEqual(['first draft', 'Let me check first.', 'The answer is 42.', 'answer to next'])
    await waitFor(allCompleted(host), 'both lines completed')
    controller.abort()
    await replacement
  } finally {
    controller.abort()
    await host.stop()
  }
})

test('a turn lost after the model started resumes that conversation when it re-runs', async () => {
  const host = await startHost()
  sdk.respond = (call) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'ses-lost' }
      yield sdk.assistant('working on it')
      await untilAborted(call)
    })()
  const controller = new AbortController()
  try {
    await loseRunnerMidTurn(host, ['working on it'])

    sdk.respond = (call) =>
      (async function* () {
        yield sdk.assistant(`resumed ${call.resume} for ${call.prompt}`)
        yield sdk.success(call.resume ?? 'ses-fresh')
      })()
    await host.send('next')
    const replacement = runRunner({
      url: host.url,
      token: host.latestToken(),
      signal: controller.signal,
    })
    expect(await host.reply()).toBe('resumed ses-lost for hello')
    controller.abort()
    await replacement
  } finally {
    controller.abort()
    await host.stop()
  }
})
