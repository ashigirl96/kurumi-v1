import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

test('a missing conversation retries with a usable kurumi server while the first transport is open', async () => {
  const host = await startHost()
  const answer = sdk.respond
  sdk.respond = (call) =>
    (async function* () {
      const server = call.mcpServers?.kurumi
      if (server?.type !== 'sdk') throw new Error('missing kurumi server')
      await server.instance.connect({
        async start() {},
        async send() {},
        async close() {},
      })
      yield* answer(call)
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    sdk.forget()
    await host.send('list accounts again')
    expect(await host.reply()).toBe('model heard: list accounts again')
    expect(sdk.calls).toHaveLength(3)
    expect(sdk.calls[1]?.resume).not.toBeNull()
    expect(sdk.calls[2]?.resume).toBeNull()
    expect(sdk.calls[2]?.mcpServers?.kurumi).not.toBe(sdk.calls[1]?.mcpServers?.kurumi)
  } finally {
    controller.abort()
    await running
    for (const call of sdk.calls) {
      const server = call.mcpServers?.kurumi
      if (server?.type === 'sdk') await server.instance.close()
    }
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

test('a turn with a background subagent posts only main-agent replies before the next line runs', async () => {
  const host = await startHost()
  sdk.respond = (call) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'ses-bg' }
      if (call.prompt === 'hello') {
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg1' }] }
        yield { ...sdk.assistant('subagent started'), parent_tool_use_id: 'toolu_bg1' }
        yield { ...sdk.assistant('started'), parent_tool_use_id: null }
        yield sdk.success('ses-bg')
        yield { ...sdk.assistant('subagent finished'), parent_tool_use_id: 'toolu_bg1' }
        yield { type: 'system', subtype: 'task_notification', task_id: 'bg1' }
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
        yield { ...sdk.assistant('the background command finished'), parent_tool_use_id: null }
      } else yield sdk.assistant(`answer to ${call.prompt}`)
      yield sdk.success('ses-bg')
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('started')
    await host.send('next')
    expect(await host.reply()).toBe('the background command finished')
    expect(await host.reply()).toBe('answer to next')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('a resumed turn that first closes a leftover notification still posts its reply', async () => {
  const host = await startHost()
  sdk.respond = (call) =>
    (async function* () {
      if (call.prompt === 'next') {
        yield { type: 'system', subtype: 'task_notification', task_id: 'bg1' }
        yield { ...sdk.success('ses-left'), num_turns: 0 }
      }
      yield { type: 'system', subtype: 'init', session_id: 'ses-left' }
      yield sdk.assistant(`answer to ${call.prompt}`)
      yield sdk.success('ses-left')
    })()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('answer to hello')
    await host.send('next')
    await host.send('last')
    expect(await host.reply()).toBe('answer to next')
    expect(await host.reply()).toBe('answer to last')
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

test('fresh and resumed turns receive current instructions without loading workspace settings', async () => {
  const host = await startHost()
  host.updatePersona('First persona')
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    expect(sdk.calls[0]?.resume).toBeNull()
    expect(sdk.calls[0]?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Your name is work.\n\nFirst persona\n\nTrusted base',
      snapshot: false,
    })
    expect(sdk.calls[0]?.settingSources).toEqual([])
    host.updatePersona('Changed persona')
    await host.send('next warm turn')
    expect(await host.reply()).toBe('model heard: hello | next warm turn')
    expect(sdk.calls[1]?.resume).not.toBeNull()
    expect(sdk.calls[1]?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Your name is work.\n\nChanged persona\n\nTrusted base',
      snapshot: false,
    })
    expect(sdk.calls[1]?.settingSources).toEqual([])
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})

test('auto-memory stays disabled even when the inherited SDK environment enables it', async () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  const host = await startHost()
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    expect(sdk.calls[0]?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(sdk.calls[0]?.skills).toEqual([])
    expect(sdk.calls[0]?.settingSources).toEqual([])
  } finally {
    controller.abort()
    await running
    await host.stop()
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous
  }
})

test('fresh and resumed SDK turns receive both current memory indexes with separate caps', async () => {
  const host = await startHost()
  const memory = join(host.folder, 'memory/index.md')
  const system = join(host.folder, 'system/index.md')
  mkdirSync(join(host.folder, 'memory'))
  mkdirSync(join(host.folder, 'system'))
  writeFileSync(memory, '😀'.repeat(16000) + 'PRIVATE OVERFLOW')
  writeFileSync(system, 's'.repeat(16000) + 'PRIVATE SYSTEM OVERFLOW')
  const controller = new AbortController()
  const running = runRunner({ url: host.url, token: host.token, signal: controller.signal })
  try {
    expect(await host.reply()).toBe('model heard: hello')
    expect(sdk.calls[0]?.resume).toBeNull()
    expect(sdk.calls[0]?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append:
        'Your name is work.\n\nTrusted base\n\n### memory/index.md\n\n' +
        '😀'.repeat(16000) +
        '\n\n### system/index.md\n\n' +
        's'.repeat(16000),
      snapshot: false,
    })
    writeFileSync(memory, 'The owner prefers tea.')
    writeFileSync(system, 'Read linked facts before answering.')
    await host.send('next warm turn')
    expect(await host.reply()).toBe('model heard: hello | next warm turn')
    expect(sdk.calls[1]?.resume).not.toBeNull()
    expect(sdk.calls[1]?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append:
        'Your name is work.\n\nTrusted base\n\n### memory/index.md\n\nThe owner prefers tea.\n\n### system/index.md\n\nRead linked facts before answering.',
      snapshot: false,
    })
    expect(sdk.calls[1]?.skills).toEqual([])
    expect(sdk.calls[1]?.settingSources).toEqual([])
    expect(sdk.calls[1]?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
  } finally {
    controller.abort()
    await running
    await host.stop()
  }
})
