import { spawn } from 'node:child_process'

export type CliResult = { code: number | null; stdout: string; stderr: string }
export type CliProcess = { result: Promise<CliResult>; kill(): void }
export type Cli = {
  start(args: readonly string[], options?: { onLine?: (line: string) => void }): CliProcess
}

export const outputLimit = 64 * 1024
export const diagnosticLimit = 16 * 1024

export const nativeCli: Cli = {
  start(args, options = {}) {
    // A signal to the host's process group must not end a create the daemon would still finish.
    const child = spawn('docker', [...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let failure: Error | undefined
    const overflow = () => {
      failure ??= new Error(`stdout exceeds ${outputLimit} bytes`)
      child.kill('SIGKILL')
    }
    const { onLine } = options
    const result = new Promise<CliResult>((resolve, reject) => {
      if (onLine) {
        let partial = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          const lines = (partial + chunk).split('\n')
          partial = lines.pop() ?? ''
          if (partial.length > outputLimit) overflow()
          for (const line of lines) onLine(line)
        })
      } else {
        child.stdout.on('data', (chunk: Buffer) => {
          if (stdoutBytes + chunk.length > outputLimit) {
            overflow()
            return
          }
          stdoutBytes += chunk.length
          stdout.push(chunk)
        })
      }
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

export function endedBySignal(exit: CliResult): boolean {
  // The docker CLI is a Go program, and Go's runtime exits 2 on SIGQUIT and SIGABRT.
  return exit.code === null || exit.code > 128 || exit.code === 2
}
