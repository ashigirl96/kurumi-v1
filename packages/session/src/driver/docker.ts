import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export type CliResult = { code: number | null; stdout: string; stderr: string }
export type CliProcess = { result: Promise<CliResult>; kill(): void }
export type Cli = { start(args: readonly string[]): CliProcess }

const outputLimit = 64 * 1024
const diagnosticLimit = 16 * 1024

class CleanupError extends Error {
  readonly cleanupFailed = true
}

const nativeCli: Cli = {
  start(args) {
    const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let failure: Error | undefined
    const result = new Promise<CliResult>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes + chunk.length > outputLimit) {
          failure ??= new Error(`stdout exceeds ${outputLimit} bytes`)
          child.kill('SIGKILL')
          return
        }
        stdoutBytes += chunk.length
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = diagnosticLimit - stderrBytes
        if (remaining <= 0) return
        const captured = chunk.subarray(0, remaining)
        stderrBytes += captured.length
        stderr.push(captured)
      })
      child.once('error', (error) => {
        failure = error
      })
      child.once('close', (code) => {
        if (failure) reject(failure)
        else
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          })
      })
    })
    return {
      result,
      kill: () => {
        child.kill('SIGKILL')
      },
    }
  },
}

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

export function createDockerDriver(options: {
  install: string
  image: string
  network?: string
  timeoutMs?: number
  cli?: Cli
}): { probe(url: string, options?: { signal?: AbortSignal }): Promise<string> } {
  const cli = options.cli ?? nativeCli
  const timeoutMs = options.timeoutMs ?? 10_000
  const error = (message: string, cause?: unknown) =>
    new Error(`Docker (${options.image}): ${message}`, { cause })
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw error('timeoutMs must be a positive integer no greater than 2147483647')
  }
  let ownedName: string | undefined
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
    if (exit.code !== 0) {
      const status = exit.code === null ? 'terminated by signal' : `exit ${exit.code}`
      throw error(`${operation}: ${status}: ${exit.stderr.slice(0, diagnosticLimit)}`)
    }
    if (Buffer.byteLength(exit.stdout) > outputLimit)
      throw error(`${operation}: stdout exceeds ${outputLimit} bytes`)
    return exit.stdout
  }

  async function run(args: readonly string[]): Promise<string> {
    try {
      return await result(cli.start(args), args[0] ?? 'command')
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith(`Docker (${options.image}):`))
        throw cause
      throw normalize(args[0] ?? 'command', cause)
    }
  }

  async function cleanup(): Promise<void> {
    if (!ownedName) return
    const name = ownedName
    try {
      await run(['rm', '--force', name])
    } catch (removalError) {
      try {
        const names = await run([
          'ps',
          '-a',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ])
        if (names.trim() !== '') throw error(`container ${name} still exists`)
      } catch (absenceError) {
        throw new CleanupError(
          `Docker (${options.image}): cleanup of ${name} failed: ${String(removalError)}; ${String(absenceError)}`,
          { cause: absenceError },
        )
      }
    }
    ownedName = undefined
  }

  return {
    async probe(url, { signal } = {}) {
      if (active) throw error('probe already in progress')
      active = true
      let name: string | undefined
      let attach: CliProcess | undefined
      const aborted = Promise.withResolvers<never>()
      const abort = () => {
        attach?.kill()
        aborted.reject(error('probe aborted'))
      }
      let body = ''
      let failure: Error | undefined
      try {
        await cleanup()
        if (signal?.aborted) throw error('probe aborted')
        name = `kurumi-probe-${randomUUID()}`
        ownedName = name
        await run([
          'create',
          '--rm',
          '--init',
          '--name',
          ownedName,
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
          attach = cli.start(['start', '--attach', ownedName])
        } catch (cause) {
          throw normalize('start', cause)
        }
        const attached = result(attach, 'start')
        const raced = Promise.race([attached, aborted.promise])
        signal?.addEventListener('abort', abort, { once: true })
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
    },
  }
}
