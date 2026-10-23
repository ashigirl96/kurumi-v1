import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { contract } from '@kurumi/session/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

type Host = ContractRouterClient<{ session: typeof contract }>

function replyId(inboundId: string): string {
  const hash = createHash('sha256').update(`kurumi-echo:${inboundId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export async function runRunner(options: {
  url: string
  token: string
  signal: AbortSignal
  onRetry?(entry: { kind: 'runner.retry'; delayMs: number }): void
}): Promise<void> {
  const { signal } = options
  const host: Host = createORPCClient(
    new RPCLink({
      url: `${options.url.replace(/\/$/, '')}/rpc`,
      headers: { authorization: `Bearer ${options.token}` },
    }),
  )
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    let delayMs = 100
    while (true) {
      signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof ORPCError && error.status >= 400 && error.status < 500) throw error
        options.onRetry?.({ kind: 'runner.retry', delayMs })
        await delay(delayMs, undefined, { signal })
        delayMs = Math.min(delayMs * 2, 5000)
      }
    }
  }
  try {
    while (!signal.aborted) {
      const { messages } = await retry(() =>
        host.session.channel.pull({ waitMs: 25_000 }, { signal }),
      )
      for (const message of messages) {
        await retry(() =>
          host.session.channel.post(
            {
              id: replyId(message.id),
              inReplyTo: message.id,
              to: null,
              body: { kind: 'text', text: `echo: ${message.content}` },
            },
            { signal },
          ),
        )
        await retry(() => host.session.channel.complete({ ids: [message.id] }, { signal }))
      }
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
