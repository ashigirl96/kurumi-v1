import { randomUUID } from 'node:crypto'

import { outputLimit, diagnosticLimit, type Cli, type CliProcess, type CliResult } from './cli.ts'
import { CleanupError, type Creation } from './create.ts'

function fetchProgram(timeoutMs: number): string {
  return `
const response = await fetch(Bun.argv.at(-1), { signal: AbortSignal.timeout(${timeoutMs}) });
if (!response.ok) throw new Error('HTTP ' + response.status);
const chunks = [];
let size = 0;
for await (const chunk of response.body ?? []) {
  size += chunk.length;
  if (size > ${outputLimit}) throw new Error('probe response exceeds ${outputLimit} bytes');
  chunks.push(chunk);
}
await Bun.write(Bun.stdout, Buffer.concat(chunks));
`
}

export function createProbe({
  cli,
  options,
  timeoutMs,
  error,
  settleCreate,
}: {
  cli: Cli
  options: { install: string; image: string; network?: string }
  timeoutMs: number
  error: (message: string, cause?: unknown) => Error
  settleCreate: (proc: CliProcess) => Creation
}) {
  let owned:
    | { name: string; kind: 'uncertain' | 'confirmed' | 'absent'; create: Creation | undefined }
    | undefined
  let active = false

  function normalize(operation: string, cause: unknown): Error {
    return error(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
  }

  async function result(proc: CliProcess, operation: string): Promise<string> {
    let exit: CliResult
    try {
      exit = await proc.result
    } catch (cause) {
      throw normalize(operation, cause)
    }
    return output(exit, operation)
  }

  function output(exit: CliResult, operation: string): string {
    if (exit.code !== 0) {
      const status = exit.code === null ? 'terminated by signal' : `exit ${exit.code}`
      throw error(`${operation}: ${status}: ${exit.stderr.slice(0, diagnosticLimit)}`)
    }
    if (Buffer.byteLength(exit.stdout) > outputLimit)
      throw error(`${operation}: stdout exceeds ${outputLimit} bytes`)
    return exit.stdout
  }

  async function run(args: readonly string[]): Promise<string> {
    const operation = args[0] ?? 'command'
    const container = operation === 'create' ? owned : undefined
    try {
      const proc = cli.start(args)
      if (container) container.create = settleCreate(proc)
      const exit = await (container?.create?.result ?? proc.result)
      if (container) {
        if (exit.code === 0) container.kind = 'confirmed'
        else if (/^(?:Error response from daemon: )?No such image: [^\r\n]+\s*$/.test(exit.stderr))
          container.kind = 'absent'
      }
      return output(exit, operation)
    } catch (cause) {
      if (
        container &&
        cause instanceof Error &&
        'code' in cause &&
        typeof cause.code === 'string' &&
        'syscall' in cause &&
        cause.syscall === 'spawn docker'
      )
        container.kind = 'absent'
      if (cause instanceof Error && cause.message.startsWith(`Docker (${options.image}):`))
        throw cause
      throw normalize(operation, cause)
    }
  }

  async function cleanup(): Promise<void> {
    if (!owned) return
    if (owned.create?.state === 'unconfirmed')
      throw new CleanupError(
        `Docker (${options.image}): cleanup of ${owned.name} unconfirmed: create ended without a daemon answer`,
      )
    const { name, kind } = owned
    let removed = false
    let removing = false
    let removalError = 'removal unconfirmed'
    try {
      const exit = await cli.start(['rm', '--force', name]).result
      removing =
        exit.code !== 0 &&
        /^(?:Error response from daemon: )?removal (?:of container [^\r\n]+ is )?already in progress\s*$/.test(
          exit.stderr,
        )
      if (
        exit.code !== 0 &&
        /^(?:Error response from daemon: )?No such container(?:: [^\r\n]+)?\s*$/.test(exit.stderr)
      ) {
        removed = true
      } else {
        const stdout = output(exit, 'rm')
        removed = kind !== 'uncertain' || stdout.trim() === name
      }
    } catch (cause) {
      removalError = String(cause)
    }
    if (!removed) {
      try {
        const deadline = performance.now() + timeoutMs
        while (true) {
          const names = await run([
            'ps',
            '-a',
            '--filter',
            `name=^/${name}$`,
            '--format',
            '{{.Names}}',
          ])
          if (names.trim() === '') break
          const remaining = deadline - performance.now()
          if (!removing || remaining <= 0) throw error(`container ${name} still exists`)
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
        }
      } catch (absenceError) {
        throw new CleanupError(
          `Docker (${options.image}): cleanup of ${name} failed: ${removalError}; ${String(absenceError)}`,
          { cause: absenceError },
        )
      }
    }
    owned = undefined
  }

  async function probe(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    if (active) throw error('probe already in progress')
    active = true
    let name: string | undefined
    let attach: CliProcess | undefined
    let aborted: ReturnType<typeof Promise.withResolvers<never>> | undefined
    const abort = () => {
      owned?.create?.cancel()
      attach?.kill()
      aborted?.reject(error('probe aborted'))
    }
    let body = ''
    let failure: Error | undefined
    try {
      await cleanup()
      if (signal?.aborted) throw error('probe aborted')
      name = `kurumi-probe-${randomUUID()}`
      owned = { name, kind: 'uncertain', create: undefined }
      signal?.addEventListener('abort', abort, { once: true })
      await run([
        'create',
        '--rm',
        '--init',
        '--name',
        name,
        '--label',
        `kurumi.install=${options.install}`,
        '--label',
        'kurumi.role=probe',
        '--network',
        options.network ?? 'bridge',
        '--pull',
        'never',
        ...(process.platform === 'linux'
          ? ['--add-host', 'host.docker.internal:host-gateway']
          : []),
        options.image,
        'bun',
        '-e',
        fetchProgram(timeoutMs),
        url,
      ])
      if (signal?.aborted) throw error('probe aborted')
      try {
        attach = cli.start(['start', '--attach', name])
      } catch (cause) {
        throw normalize('start', cause)
      }
      const attached = result(attach, 'start')
      aborted = Promise.withResolvers<never>()
      const raced = Promise.race([attached, aborted.promise])
      if (signal?.aborted) abort()
      body = await raced
    } catch (cause) {
      failure = cause instanceof Error ? cause : normalize('probe', cause)
    } finally {
      signal?.removeEventListener('abort', abort)
      try {
        if (name) await cleanup()
      } catch (cleanupError) {
        failure =
          failure === undefined
            ? cleanupError instanceof Error
              ? cleanupError
              : normalize('cleanup', cleanupError)
            : new CleanupError(
                `Docker (${options.image}): ${String(failure)}; ${String(cleanupError)}`,
                { cause: cleanupError },
              )
      }
      if (attach) await attach.result.catch(() => {})
      active = false
    }
    if (failure !== undefined) throw failure
    if (signal?.aborted) throw error('probe aborted')
    return body
  }

  return {
    probe,
    cleanup,
    owns(name: string) {
      return name === owned?.name
    },
    settleListedCreate(listedAt: number) {
      const create = owned?.create
      if (create?.state === 'unconfirmed' && (create.endedAt ?? Infinity) <= listedAt)
        create.state = 'settled'
    },
    hasOwned() {
      return owned !== undefined
    },
  }
}
