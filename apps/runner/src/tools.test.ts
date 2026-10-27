import { expect, test } from 'bun:test'

import { kc } from '@kurumi/rpc/contract'
import type { ClientLink } from '@orpc/client'
import { z } from 'zod'

import { createKurumiServer, runnerContract, toolsOf } from './tools.ts'

const signal = new AbortController().signal
const calls: { path: readonly string[]; input: unknown }[] = []
const link: ClientLink<Record<string, never>> = {
  async call(path, input) {
    calls.push({ path, input })
    return { accounts: [] }
  },
}

test('only procedures with tool metadata become tools, including nested procedures', () => {
  expect(toolsOf({ private: kc, channel: kc.meta({ agent: 'channel' }) }, link, signal)).toEqual([])
  expect(toolsOf(runnerContract, link, signal).map(({ name }) => name)).toEqual(['list_accounts'])
  expect(createKurumiServer(link, signal)).toMatchObject({ name: 'kurumi', type: 'sdk' })
})

test('tool metadata without agent access is refused', () => {
  expect(() =>
    toolsOf(
      { unsafe: kc.meta({ tool: { name: 'unsafe', instructions: 'unsafe' } }) },
      link,
      signal,
    ),
  ).toThrow('unsafe has tool metadata without agent access')
})

test('duplicate tool names in separate contract branches fail at startup', () => {
  const duplicate = kc.meta({
    agent: 'own-group',
    tool: { name: 'duplicate', instructions: 'duplicate' },
  })
  expect(() => toolsOf({ first: { one: duplicate }, second: duplicate }, link, signal)).toThrow(
    'Duplicate tool name: duplicate',
  )
})

test('aborting a turn cancels its in-flight tool RPC without stopping the runner', async () => {
  const turn = new AbortController()
  let received: AbortSignal | undefined
  const pendingLink: ClientLink<Record<string, never>> = {
    async call(_path, _input, options) {
      received = options.signal
      return new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('turn aborted')), {
          once: true,
        })
      })
    },
  }
  const [list] = toolsOf(runnerContract, pendingLink, signal)
  if (!list) throw new Error('missing list_accounts')
  const pending = list.handler({}, { signal: turn.signal })
  turn.abort()
  expect(received?.aborted).toBe(true)
  expect(signal.aborted).toBe(false)
  expect(await pending.catch((error: unknown) => error)).toEqual(new Error('turn aborted'))
})

test('handlers forward the contract path and input on the existing link', async () => {
  calls.length = 0
  const tools = toolsOf(runnerContract, link, signal)
  expect(await tools[0]?.handler({}, undefined)).toEqual({
    content: [{ type: 'text', text: '{"accounts":[]}' }],
  })
  const [echo] = toolsOf(
    {
      nested: {
        echo: kc
          .meta({ agent: 'own-group', tool: { name: 'echo', instructions: 'echo' } })
          .input(z.object({ text: z.string() })),
      },
    },
    link,
    signal,
  )
  await echo?.handler({ text: 'hello' }, undefined)
  expect(calls).toEqual([
    { path: ['account', 'mine'], input: undefined },
    { path: ['nested', 'echo'], input: { text: 'hello' } },
  ])
})

test('a tool with a non-object input fails before advertising an invalid schema', () => {
  expect(() =>
    toolsOf(
      {
        invalid: kc
          .meta({ agent: 'own-group', tool: { name: 'invalid', instructions: 'invalid' } })
          .input(z.string()),
      },
      link,
      signal,
    ),
  ).toThrow('invalid needs an object input schema for a tool')
})
