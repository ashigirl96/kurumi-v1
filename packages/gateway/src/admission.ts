import { randomUUID } from 'node:crypto'

import type { AgentPort } from './port.ts'

export type AdmissionState =
  | { kind: 'binding' }
  | { kind: 'probing'; port: number }
  | { kind: 'open'; port: number; openedAt: number; bindToOpenMs: number }
  | {
      kind: 'unreachable'
      reason: { kind: 'probe_failed' | 'nonce_mismatch' | 'stopped'; message: string }
    }
  | { kind: 'bind_failed'; reason: { message: string; code: string | null } }

export type ProbeTiming =
  | { kind: 'never' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'finished'; startedAt: number; durationMs: number }

export type AdmissionSnapshot = { state: AdmissionState; lastProbe: ProbeTiming }
export type Admission = {
  status(): AdmissionSnapshot
  retry(): Promise<void>
  stop(): Promise<void>
}

type AdmissionDeps = {
  bind(probeNonce: () => string | null): Promise<Pick<AgentPort, 'port' | 'stop'>>
  probe(url: string, options: { signal: AbortSignal }): Promise<string>
  retryMs?: number
  maxRetryMs?: number
  log?(line: string): void
  schedule?(this: void, callback: () => void, delayMs: number): () => void
}

export function startAdmission(deps: AdmissionDeps): Admission {
  const retryMs = deps.retryMs ?? 1_000
  const maxRetryMs = deps.maxRetryMs ?? Math.max(retryMs, 30_000)
  for (const [name, value] of Object.entries({ retryMs, maxRetryMs })) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} must be positive and finite, no greater than 2147483647`)
    }
  }
  if (maxRetryMs < retryMs) throw new Error('maxRetryMs must be at least retryMs')
  const schedule =
    deps.schedule ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  let state: AdmissionState = { kind: 'binding' }
  let lastProbe: ProbeTiming = { kind: 'never' }
  let listener: Pick<AgentPort, 'port' | 'stop'> | undefined
  let boundAt = 0
  let nonce: string | null = null
  let active: Promise<void> | undefined
  let controller: AbortController | undefined
  let cancelRetry: (() => void) | undefined
  let delayMs = retryMs
  let stopping = false
  let stopped: Promise<void> | undefined
  let cleanupFailure: unknown

  async function attempt(): Promise<void> {
    if (stopping) return
    if (!listener) {
      state = { kind: 'binding' }
      try {
        listener = await deps.bind(() => nonce)
        boundAt = performance.now()
      } catch (error) {
        if (!stopping) {
          state = {
            kind: 'bind_failed',
            reason: {
              message: error instanceof Error ? error.message : String(error),
              code:
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : null,
            },
          }
        }
        return
      }
    }
    if (stopping) return
    nonce = randomUUID()
    const expected = nonce
    controller = new AbortController()
    state = { kind: 'probing', port: listener.port }
    const startedAt = Date.now()
    const started = performance.now()
    lastProbe = { kind: 'running', startedAt }
    try {
      const response = await deps.probe(
        `http://host.docker.internal:${listener.port}/probe/${expected}`,
        { signal: controller.signal },
      )
      cleanupFailure = undefined
      if (stopping) return
      if (response !== expected) {
        state = {
          kind: 'unreachable',
          reason: {
            kind: 'nonce_mismatch',
            message: 'Probe response did not match admission nonce',
          },
        }
        return
      }
      const bindToOpenMs = performance.now() - boundAt
      state = { kind: 'open', port: listener.port, openedAt: Date.now(), bindToOpenMs }
      deps.log?.(`admission open after ${Math.round(bindToOpenMs)} ms`)
    } catch (error) {
      cleanupFailure =
        typeof error === 'object' &&
        error !== null &&
        'cleanupFailed' in error &&
        error.cleanupFailed === true
          ? error
          : undefined
      if (!stopping) {
        state = {
          kind: 'unreachable',
          reason: {
            kind: 'probe_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    } finally {
      nonce = null
      controller = undefined
      lastProbe = { kind: 'finished', startedAt, durationMs: performance.now() - started }
    }
  }

  function retry(): Promise<void> {
    cancelRetry?.()
    cancelRetry = undefined
    if (active) return active
    if (stopping || state.kind === 'open') return Promise.resolve()
    active = Promise.resolve()
      .then(attempt)
      .finally(() => {
        active = undefined
        if (!stopping && state.kind !== 'open') {
          const nextDelay = delayMs
          delayMs = Math.min(maxRetryMs, delayMs * 2)
          cancelRetry = schedule(() => {
            cancelRetry = undefined
            retry().catch(() => {})
          }, nextDelay)
        }
      })
    return active
  }

  function stop(): Promise<void> {
    if (stopped) return stopped
    stopping = true
    nonce = null
    cancelRetry?.()
    cancelRetry = undefined
    state = { kind: 'unreachable', reason: { kind: 'stopped', message: 'Admission stopped' } }
    stopped = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      try {
        await active
      } catch (error) {
        failures.push(error)
      }
      if (cleanupFailure !== undefined) failures.push(cleanupFailure)
      try {
        await listener?.stop()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Admission shutdown failed')
    })
    controller?.abort()
    return stopped
  }

  retry().catch(() => {})
  return { status: () => structuredClone({ state, lastProbe }), retry, stop }
}
