import { expect, test } from 'bun:test'

import type { Card, DeliveryTarget } from './contract.ts'
import { createTerminalAdapter } from './terminal.ts'

const target: DeliveryTarget = {
  channel: 'terminal',
  instance: null,
  platformId: 'ag-work',
  threadId: null,
}
const card: Card = {
  owner: 'account.connect',
  ref: 'cr-test',
  title: 'work に Google を接続',
  body: 'gmail',
  buttons: [{ action: 'connect', label: '接続する' }],
}

test('cards and replacements reach subscribers as URL-free text replies with press commands', async () => {
  const adapter = createTerminalAdapter()
  const stream = adapter.subscribe(target)
  try {
    for (const method of ['postCard', 'replaceCard'] as const) {
      expect(await adapter[method](target, { id: 'out-card', card })).toEqual({
        platformMessageId: 'out-card',
      })
      const reply = await stream.next()
      expect(reply.value).toEqual({
        kind: 'reply',
        outboundId: 'out-card',
        text: 'cr-test\nwork に Google を接続\ngmail\n接続する: kurumi chat press cr-test connect',
      })
      expect(JSON.stringify(reply.value)).not.toMatch(/https?:|\/connect\//)
    }
  } finally {
    await stream.return?.()
    adapter.stop()
  }
})

test('a completed card prints the same ref and only the replacement line', async () => {
  const adapter = createTerminalAdapter()
  const stream = adapter.subscribe(target)
  try {
    await adapter.replaceCard(target, {
      id: 'out-card',
      card: { ...card, title: '接続をキャンセルしました', body: '', buttons: [] },
    })
    expect((await stream.next()).value).toEqual({
      kind: 'reply',
      outboundId: 'out-card',
      text: 'cr-test\n接続をキャンセルしました',
    })
  } finally {
    await stream.return?.()
    adapter.stop()
  }
})
