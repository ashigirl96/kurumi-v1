import { expect, test } from 'bun:test'

import { startAdmission, type AdmissionState } from './admission.ts'
import { startAgentPort } from './port.ts'

test('opens only after the probe returns the exact active nonce', async () => {
  const admission = startAdmission({
    bind: async () => ({ port: 43126, stop: async () => {} }),
    probe: async (url) => url.slice(url.lastIndexOf('/') + 1),
  })
  expect(admission.status().state.kind).toBe('binding')
  await admission.retry()
  expect(admission.status().state.kind).toBe('open')
  await admission.stop()
})

test.each(['wrong nonce', 'trailing newline'])(
  'rejects successful stdout with %s',
  async (mode) => {
    const clock = retryClock()
    let current: (() => string | null) | undefined
    const admission = startAdmission({
      bind: async (nonce) => {
        current = nonce
        return port()
      },
      probe: async (url) => (mode === 'wrong nonce' ? 'wrong' : `${nonceFrom(url)}\n`),
      schedule: clock.schedule,
    })
    await admission.retry()
    expect(admission.status().state).toEqual({
      kind: 'unreachable',
      reason: { kind: 'nonce_mismatch', message: 'Probe response did not match admission nonce' },
    })
    expect(current?.()).toBeNull()
    expect(clock.delays).toEqual([1000])
    await admission.stop()
  },
)

test('failed binds retain their reason and recover by binding again', async () => {
  let binds = 0
  let probes = 0
  const clock = retryClock()
  const admission = startAdmission({
    bind: async (nonce) => {
      expect(nonce()).toBeNull()
      if (++binds === 1) throw Object.assign(new Error('Address in use'), { code: 'EADDRINUSE' })
      return port()
    },
    probe: async (url) => {
      probes++
      return nonceFrom(url)
    },
    retryMs: 5,
    schedule: clock.schedule,
  })
  await admission.retry()
  expect(admission.status()).toEqual({
    state: { kind: 'bind_failed', reason: { message: 'Address in use', code: 'EADDRINUSE' } },
    lastProbe: { kind: 'never' },
  })
  expect(probes).toBe(0)
  expect(clock.delays).toEqual([5])
  clock.fire()
  await admission.retry()
  expect(binds).toBe(2)
  expect(admission.status().state.kind).toBe('open')
  expect(clock.pending()).toBe(0)
  await admission.stop()
})

test('retries from completed failures at exact exponentially capped delays', async () => {
  const clock = retryClock()
  let binds = 0
  const admission = startAdmission({
    bind: async () => {
      binds++
      return port()
    },
    probe: async () => {
      throw new Error('Docker missing image')
    },
    retryMs: 3,
    maxRetryMs: 10,
    schedule: clock.schedule,
  })
  await admission.retry()
  for (let index = 0; index < 4; index++) {
    clock.fire()
    await admission.retry()
  }
  expect(clock.delays).toEqual([3, 6, 10, 10, 10])
  expect(binds).toBe(1)
  expect(admission.status().state).toEqual({
    kind: 'unreachable',
    reason: { kind: 'probe_failed', message: 'Docker missing image' },
  })
  await admission.stop()
  expect(clock.pending()).toBe(0)
})

test('manual retry cancels the pending timer and active retries share one promise', async () => {
  const clock = retryClock()
  const slow = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<string>()
  let probes = 0
  const admission = startAdmission({
    bind: async () => port(),
    probe: async (url) => {
      if (++probes === 1) throw new Error('Docker unavailable')
      entered.resolve(url)
      return slow.promise
    },
    schedule: clock.schedule,
  })
  await admission.retry()
  expect(clock.pending()).toBe(1)
  const first = admission.retry()
  expect(clock.pending()).toBe(0)
  const url = await entered.promise
  expect(admission.retry()).toBe(first)
  expect(admission.retry()).toBe(first)
  expect(probes).toBe(2)
  expect(clock.delays).toEqual([1000])
  slow.resolve(nonceFrom(url))
  await first
  await admission.retry()
  expect(probes).toBe(2)
  expect(clock.pending()).toBe(0)
  await admission.stop()
})

test('bind dependency can reenter retry without creating a second attempt', async () => {
  let reentered: Promise<void> | undefined
  let binds = 0
  const admission = startAdmission({
    bind: async () => {
      binds++
      reentered = admission.retry()
      return port()
    },
    probe: async (url) => nonceFrom(url),
  })
  const first = admission.retry()
  await first
  expect(reentered).toBe(first)
  expect(binds).toBe(1)
  await admission.stop()
})

test('the HTTP proof route requires the exact current GET and cannot itself open admission', async () => {
  const entered = Promise.withResolvers<string>()
  const response = Promise.withResolvers<string>()
  const admission = startAdmission({
    bind: (probeNonce) =>
      startAgentPort({
        bind: { host: '127.0.0.1', port: 0 },
        authenticate: () => null,
        intercepts: () => false,
        forward: { inject: ({ path, headers }) => ({ path, headers }) },
        probeNonce,
      }),
    probe: (url) => {
      entered.resolve(url)
      return response.promise
    },
  })
  try {
    const url = new URL(await entered.promise)
    const state = admission.status().state
    expect(state.kind).toBe('probing')
    if (state.kind !== 'probing') throw new Error('Expected bound probe')
    expect(url.port).toBe(String(state.port))
    const local = `http://127.0.0.1:${state.port}`
    for (const path of ['/probe/wrong', `${url.pathname}/extra`, `${url.pathname}?x=1`, '/']) {
      expect((await fetch(`${local}${path}`)).status).toBe(404)
      expect(admission.status().state.kind).toBe('probing')
    }
    expect((await fetch(`${local}${url.pathname}`, { method: 'POST' })).status).toBe(404)
    const correct = await fetch(`${local}${url.pathname}`)
    expect(correct.status).toBe(200)
    expect(await correct.text()).toBe(nonceFrom(url.href))
    expect(admission.status().state.kind).toBe('probing')
    response.resolve(nonceFrom(url.href))
    await admission.retry()
    expect(admission.status().state.kind).toBe('open')
    expect((await fetch(`${local}${url.pathname}`)).status).toBe(404)
  } finally {
    response.resolve('late')
    await admission.stop()
  }
})

test('stop during bind waits for and closes the late listener without probing', async () => {
  const binding = Promise.withResolvers<ReturnType<typeof port>>()
  const entered = Promise.withResolvers<void>()
  let closed = false
  let probes = 0
  const admission = startAdmission({
    bind: () => {
      entered.resolve()
      return binding.promise
    },
    probe: async () => {
      probes++
      return 'unexpected'
    },
  })
  await entered.promise
  let finished = false
  const stopped = admission.stop()
  expect(admission.stop()).toBe(stopped)
  void stopped.then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  binding.resolve(
    port(async () => {
      closed = true
    }),
  )
  await stopped
  expect(closed).toBe(true)
  expect(probes).toBe(0)
  expect(admission.status().state).toEqual(stoppedState)
})

test('stop revokes nonce, aborts the probe, and suppresses late success and timers', async () => {
  const entered = Promise.withResolvers<{ url: string; signal: AbortSignal }>()
  const response = Promise.withResolvers<string>()
  const clock = retryClock()
  const logs: string[] = []
  let readNonce: (() => string | null) | undefined
  let closed = false
  const admission = startAdmission({
    bind: async (nonce) => {
      readNonce = nonce
      return port(async () => {
        closed = true
      })
    },
    probe: (url, { signal }) => {
      entered.resolve({ url, signal })
      return response.promise
    },
    schedule: clock.schedule,
    log: (line) => logs.push(line),
  })
  const { url, signal } = await entered.promise
  expect(readNonce?.()).toBe(nonceFrom(url))
  const stopped = admission.stop()
  expect(readNonce?.()).toBeNull()
  expect(signal.aborted).toBe(true)
  expect(admission.status().state).toEqual(stoppedState)
  response.resolve(nonceFrom(url))
  await stopped
  expect(closed).toBe(true)
  expect(admission.status().state).toEqual(stoppedState)
  expect(admission.status().lastProbe.kind).toBe('finished')
  expect(logs).toEqual([])
  expect(clock.pending()).toBe(0)
})

test('stop closes the listener and retains cleanup failure after publishing stopped', async () => {
  const entered = Promise.withResolvers<void>()
  let readNonce: (() => string | null) | undefined
  let closed = false
  const failure = Object.assign(new Error('Docker cleanup unconfirmed'), { cleanupFailed: true })
  const admission = startAdmission({
    bind: async (nonce) => {
      readNonce = nonce
      return port(async () => {
        closed = true
      })
    },
    probe: (_url, { signal }) => {
      entered.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(failure), { once: true })
      })
    },
  })
  await entered.promise
  const stopped = admission.stop()
  expect(readNonce?.()).toBeNull()
  expect(await stopped.catch((error: unknown) => error)).toBe(failure)
  expect(closed).toBe(true)
  expect(admission.status().state).toEqual(stoppedState)
  expect(admission.stop()).toBe(stopped)
})

test.each([false, true])(
  'retains an earlier cleanup failure until a safely cleaned probe recovers (%s)',
  async (recover) => {
    const clock = retryClock()
    const failure = Object.assign(new Error('Docker cleanup unconfirmed'), { cleanupFailed: true })
    let probes = 0
    let closed = false
    const admission = startAdmission({
      bind: async () =>
        port(async () => {
          closed = true
        }),
      probe: async (url) => {
        if (++probes === 1) throw failure
        return nonceFrom(url)
      },
      schedule: clock.schedule,
    })
    await admission.retry()
    expect(admission.status().state.kind).toBe('unreachable')
    if (recover) {
      await admission.retry()
      expect(admission.status().state.kind).toBe('open')
      await admission.stop()
    } else {
      expect(await admission.stop().catch((error: unknown) => error)).toBe(failure)
    }
    expect(closed).toBe(true)
    expect(admission.status().state).toEqual(stoppedState)
  },
)

test('ordinary probe failure with confirmed cleanup does not reject stop', async () => {
  const admission = startAdmission({
    bind: async () => port(),
    probe: async () => {
      throw new Error('Docker fetch failed')
    },
    schedule: retryClock().schedule,
  })
  await admission.retry()
  await admission.stop()
  expect(admission.status().state).toEqual(stoppedState)
})

test('reports readable probe timestamps, monotonic durations, exact open log, and isolated snapshots', async () => {
  const entered = Promise.withResolvers<string>()
  const response = Promise.withResolvers<string>()
  const logs: string[] = []
  const before = Date.now()
  const admission = startAdmission({
    bind: async () => port(),
    probe: (url) => {
      entered.resolve(url)
      return response.promise
    },
    log: (line) => logs.push(line),
  })
  const url = await entered.promise
  const running = admission.status()
  expect(running.lastProbe.kind).toBe('running')
  if (running.lastProbe.kind !== 'running') throw new Error('Expected running timing')
  expect(running.lastProbe.startedAt).toBeGreaterThanOrEqual(before)
  response.resolve(nonceFrom(url))
  await admission.retry()
  const snapshot = admission.status()
  expect(snapshot.lastProbe.kind).toBe('finished')
  expect(snapshot.state.kind).toBe('open')
  if (snapshot.state.kind !== 'open' || snapshot.lastProbe.kind !== 'finished')
    throw new Error('Expected open timing')
  expect(snapshot.state.port).toBe(43126)
  expect(snapshot.lastProbe.startedAt).toBe(running.lastProbe.startedAt)
  expect(snapshot.lastProbe.durationMs).toBeGreaterThanOrEqual(0)
  expect(snapshot.state.bindToOpenMs).toBeGreaterThanOrEqual(snapshot.lastProbe.durationMs - 1)
  expect(snapshot.state.openedAt).toBeGreaterThanOrEqual(snapshot.lastProbe.startedAt)
  expect(logs).toEqual([`admission open after ${Math.round(snapshot.state.bindToOpenMs)} ms`])
  const timing = structuredClone(snapshot.lastProbe)
  snapshot.state.port = 1
  snapshot.lastProbe.durationMs = -1
  expect(admission.status().state).not.toEqual(snapshot.state)
  expect(admission.status().lastProbe).toEqual(timing)
  await admission.stop()
  expect(admission.status().lastProbe).toEqual(timing)
})

test.each([0, -1, Infinity, NaN, 2_147_483_648])(
  'rejects invalid retry timer option %s',
  (value) => {
    const deps = { bind: async () => port(), probe: async (url: string) => nonceFrom(url) }
    expect(() => startAdmission({ ...deps, retryMs: value })).toThrow('retryMs')
    expect(() => startAdmission({ ...deps, maxRetryMs: value })).toThrow('maxRetryMs')
  },
)

test('rejects a retry cap smaller than its initial delay', () => {
  expect(() =>
    startAdmission({
      bind: async () => port(),
      probe: async () => '',
      retryMs: 20,
      maxRetryMs: 10,
    }),
  ).toThrow('maxRetryMs')
})

function nonceFrom(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

function port(stop = async () => {}): { port: number; stop(): Promise<void> } {
  return { port: 43126, stop }
}

function retryClock() {
  const delays: number[] = []
  const callbacks = new Set<() => void>()
  return {
    delays,
    pending: () => callbacks.size,
    schedule: (callback: () => void, delayMs: number) => {
      delays.push(delayMs)
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
      }
    },
    fire: () => {
      const callback = callbacks.values().next().value
      if (!callback) throw new Error('No pending retry')
      callbacks.delete(callback)
      callback()
    },
  }
}

const stoppedState = {
  kind: 'unreachable',
  reason: { kind: 'stopped', message: 'Admission stopped' },
} satisfies AdmissionState
