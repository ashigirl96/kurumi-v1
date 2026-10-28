import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { contract } from '@kurumi/session/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { z } from 'zod'

import { runTurn } from './claude.ts'
import { createKurumiServer } from './tools.ts'

type Host = ContractRouterClient<{ session: typeof contract }>

const CONTINUATION = 'continuation'
const storedDeliveryFailure = z.object({ storedOutboundId: z.string() })

function deliveryFailed(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    error.code === 'SERVICE_UNAVAILABLE' &&
    storedDeliveryFailure.safeParse(error.data).success
  )
}

function slotTaken(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'CONFLICT'
}

function replyId(inboundId: string, index: number): string {
  const hash = createHash('sha256').update(`kurumi-reply:${inboundId}:${index}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export async function runRunner(options: {
  url: string
  token: string
  signal: AbortSignal
  heartbeatMs?: number
  onRetry?(entry: { kind: 'runner.retry'; delayMs: number }): void
}): Promise<void> {
  const { signal } = options
  const link = new RPCLink({
    url: `${options.url.replace(/\/$/, '')}/rpc`,
    headers: { authorization: `Bearer ${options.token}` },
  })
  const host: Host = createORPCClient(link)
  async function retry<T>(operation: () => Promise<T>, maxDeliveryFailures = Infinity): Promise<T> {
    let delayMs = 100
    let deliveryFailures = 0
    while (true) {
      signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof ORPCError && error.status >= 400 && error.status < 500) throw error
        if (deliveryFailed(error) && ++deliveryFailures >= maxDeliveryFailures) throw error
        options.onRetry?.({ kind: 'runner.retry', delayMs })
        await delay(delayMs, undefined, { signal })
        delayMs = Math.min(delayMs * 2, 5000)
      }
    }
  }
  async function fillSlot(
    id: string,
    inReplyTo: string,
    text: string,
  ): Promise<'delivered' | 'taken' | 'failed'> {
    try {
      await retry(
        () =>
          host.session.channel.post(
            { id, inReplyTo, to: null, body: { kind: 'text', text } },
            { signal },
          ),
        8,
      )
      return 'delivered'
    } catch (error) {
      if (signal.aborted) throw error
      if (slotTaken(error)) return 'taken'
      if (deliveryFailed(error)) {
        process.stderr.write(
          `${JSON.stringify({ kind: 'runner.reply.failed', inboundId: inReplyTo, outboundId: id })}\n`,
        )
        return 'failed'
      }
      throw error
    }
  }
  async function answer(message: { id: string; content: string }): Promise<void> {
    const saved = await retry(() =>
      host.session.channel.state.get({ key: CONTINUATION }, { signal }),
    )
    const heartbeat = setInterval(() => {
      host.session.channel
        .heartbeat({ currentTool: null, toolTimeoutMs: null }, { signal })
        .catch(() => {})
    }, options.heartbeatMs ?? 10_000)
    let slot = 0
    let status: 'completed' | 'failed' = 'completed'
    try {
      await runTurn({
        prompt: message.content,
        mcpServers: () => ({ kurumi: createKurumiServer(link, signal) }),
        continuation: saved.value,
        signal,
        async reply(text) {
          let result = await fillSlot(replyId(message.id, slot), message.id, text)
          while (result === 'taken') {
            slot++
            result = await fillSlot(replyId(message.id, slot), message.id, text)
          }
          if (result === 'failed') status = 'failed'
          slot++
        },
        async remember(continuation) {
          await retry(() =>
            host.session.channel.state.put({ key: CONTINUATION, value: continuation }, { signal }),
          )
        },
      })
    } finally {
      clearInterval(heartbeat)
    }
    await retry(() => host.session.channel.complete({ ids: [message.id], status }, { signal }))
  }
  try {
    while (!signal.aborted) {
      const { messages } = await retry(() =>
        host.session.channel.pull({ waitMs: 25_000 }, { signal }),
      )
      for (const message of messages) await answer(message)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

if (import.meta.main) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  try {
    const url = process.env.KURUMI_URL
    const token = process.env.KURUMI_TOKEN
    if (!url || !token || !['http:', 'https:'].includes(new URL(url).protocol)) {
      throw new Error('KURUMI_URL and KURUMI_TOKEN are required')
    }
    await runRunner({
      url,
      token,
      signal: controller.signal,
      onRetry: (entry) => {
        process.stderr.write(`${JSON.stringify(entry)}\n`)
      },
    })
  } catch {
    process.stderr.write('Runner stopped after a configuration or channel error\n')
    process.exitCode = 1
  }
}
