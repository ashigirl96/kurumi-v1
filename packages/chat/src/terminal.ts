import { ORPCError } from '@orpc/server'

import type { ChannelAdapter, DeliveryTarget, TerminalEvent } from './contract.ts'

type Reply = Extract<TerminalEvent, { kind: 'reply' }>
type QueueState = { kind: 'open' } | { kind: 'closed' } | { kind: 'failed'; error: Error }
type Subscriber = { push(reply: Reply): boolean; close: () => void }

export type TerminalAdapter = ChannelAdapter & {
  subscribe(target: DeliveryTarget, signal?: AbortSignal): AsyncIterableIterator<Reply>
  stop(): void
}

function checkTarget(target: DeliveryTarget): void {
  if (target.channel !== 'terminal' || target.instance !== null || target.threadId !== null) {
    throw new ORPCError('BAD_REQUEST', { message: 'unsupported terminal delivery target' })
  }
}

export function createTerminalAdapter(): TerminalAdapter {
  const subscribers = new Map<string, Set<Subscriber>>()
  let stopped = false

  return {
    kind: 'terminal',
    instance: null,
    ownerOnly: true,
    async post(target, body) {
      checkTarget(target)
      let delivered = false
      for (const subscriber of subscribers.get(target.platformId) ?? []) {
        if (subscriber.push({ kind: 'reply', outboundId: body.id, text: body.text }))
          delivered = true
      }
      if (!delivered) {
        throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'no active terminal subscribers' })
      }
      return { platformMessageId: body.id }
    },
    subscribe(target, signal) {
      checkTarget(target)
      if (stopped) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'terminal is stopped' })
      const peers = subscribers.get(target.platformId) ?? new Set<Subscriber>()
      subscribers.set(target.platformId, peers)
      const queue: Reply[] = []
      let state: QueueState = { kind: 'open' }
      let wake = Promise.withResolvers<void>()
      const finish = (end: Exclude<QueueState, { kind: 'open' }>) => {
        if (state.kind !== 'open') return
        state = end
        queue.length = 0
        peers.delete(subscriber)
        if (peers.size === 0) subscribers.delete(target.platformId)
        signal?.removeEventListener('abort', subscriber.close)
        wake.resolve()
      }
      const subscriber: Subscriber = {
        push(reply) {
          if (state.kind !== 'open') return false
          if (queue.length >= 128) {
            finish({
              kind: 'failed',
              error: new ORPCError('SERVICE_UNAVAILABLE', {
                message: 'terminal reply queue overflow',
              }),
            })
            return false
          }
          queue.push(reply)
          wake.resolve()
          wake = Promise.withResolvers<void>()
          return true
        },
        close: () => finish({ kind: 'closed' }),
      }
      peers.add(subscriber)
      signal?.addEventListener('abort', subscriber.close, { once: true })
      if (signal?.aborted) subscriber.close()
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          while (state.kind === 'open') {
            const reply = queue.shift()
            if (reply) return { done: false, value: reply }
            await wake.promise
          }
          if (state.kind === 'failed') throw state.error
          return { done: true, value: undefined }
        },
        async return() {
          subscriber.close()
          return { done: true, value: undefined }
        },
      }
    },
    stop() {
      stopped = true
      for (const peers of subscribers.values()) {
        for (const subscriber of peers) subscriber.close()
      }
    },
  }
}
