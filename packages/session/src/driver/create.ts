import { endedBySignal, type CliProcess, type CliResult } from './cli.ts'

export type Creation = {
  result: Promise<CliResult>
  state: 'pending' | 'settled' | 'unconfirmed'
  endedAt: number | undefined
  cancel(): void
}
export class CleanupError extends Error {
  readonly cleanupFailed = true
}

export function createCreation(options: { image: string }, timeoutMs: number) {
  const error = (message: string, cause?: unknown) =>
    new Error(`Docker (${options.image}): ${message}`, { cause })
  function settleCreate(proc: CliProcess): Creation {
    const deadline = Promise.withResolvers<never>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const create: Creation = {
      state: 'pending',
      endedAt: undefined,
      result: Promise.race([proc.result, deadline.promise])
        .then((exit) => {
          if (create.state === 'pending' && endedBySignal(exit)) create.state = 'unconfirmed'
          return exit
        })
        .finally(() => {
          clearTimeout(timer)
          if (create.state === 'pending') create.state = 'settled'
        }),
      cancel() {
        if (create.state !== 'pending' || timer !== undefined) return
        timer = setTimeout(() => {
          create.state = 'unconfirmed'
          proc.kill()
          deadline.reject(
            new CleanupError(
              `Docker (${options.image}): create cleanup unconfirmed after ${timeoutMs} ms`,
            ),
          )
        }, timeoutMs)
      },
    }
    const ended = () => {
      create.endedAt ??= performance.now()
    }
    void proc.result.then(ended, ended)
    return create
  }

  return { error, settleCreate }
}
