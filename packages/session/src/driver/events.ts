import type { Cli, CliProcess } from './cli.ts'

export type InventoryChange =
  | { kind: 'subscribed'; attempt: number }
  | { kind: 'lost'; code: number | null; retryMs: number }
  | { kind: 'event' }

export function createEvents({
  cli,
  install,
  signal,
  track,
  error,
}: {
  cli: Cli
  install: string
  signal: AbortSignal
  track: <T>(pending: Promise<T>) => Promise<T>
  error: (message: string) => Error
}) {
  let watcher: ((change: InventoryChange) => void) | undefined
  const eventWindowMs = 60_000
  let subscription: CliProcess | undefined
  let resubscribe: ReturnType<typeof setTimeout> | undefined
  let losses = 0
  let announced = false
  let since: number | undefined

  function subscribe(): void {
    resubscribe = undefined
    if (signal.aborted || !watcher) return
    const startedAt = Date.now()
    const began = performance.now()
    let proc: CliProcess
    try {
      proc = cli.start(
        [
          'events',
          ...[
            `label=kurumi.install=${install}`,
            'type=container',
            'event=create',
            'event=die',
            'event=destroy',
          ].flatMap((filter) => ['--filter', filter]),
          ...(since === undefined ? [] : ['--since', (since / 1000).toFixed(3)]),
          '--until',
          ((startedAt + eventWindowMs) / 1000).toFixed(3),
          '--format',
          '{{.Action}}',
        ],
        {
          onLine(line) {
            if (line.trim()) watcher?.({ kind: 'event' })
          },
        },
      )
    } catch {
      lost(null, began)
      return
    }
    subscription = proc
    const attempt = losses
    const confirmation = setTimeout(() => {
      if (subscription !== proc || (announced && attempt === 0)) return
      announced = true
      watcher?.({ kind: 'subscribed', attempt })
    }, 1_000)
    confirmation.unref()
    void proc.result
      .then(
        (exit) => exit.code,
        () => null,
      )
      .then((code) => {
        clearTimeout(confirmation)
        if (subscription !== proc) return
        subscription = undefined
        if (signal.aborted || !watcher) return
        const ran = performance.now() - began >= 1_000
        if (ran) since = startedAt - 1_000
        if (code === 0 && ran) {
          losses = 0
          subscribe()
        } else lost(code, began)
      })
      .catch(() => {})
  }

  function lost(code: number | null, began: number): void {
    losses = performance.now() - began >= 10_000 ? 1 : losses + 1
    const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(losses - 1, 5))
    watcher?.({ kind: 'lost', code, retryMs })
    resubscribe = setTimeout(subscribe, retryMs)
    resubscribe.unref()
  }

  function endWatch(): void {
    clearTimeout(resubscribe)
    resubscribe = undefined
    if (subscription) void track(subscription.result).catch(() => {})
    subscription?.kill()
    announced = false
    losses = 0
  }

  function watch(listener: (change: InventoryChange) => void) {
    if (watcher) throw error('the inventory already has a watcher')
    watcher = listener
    subscribe()
    return () => {
      watcher = undefined
      endWatch()
    }
  }

  return { watch, endWatch }
}
