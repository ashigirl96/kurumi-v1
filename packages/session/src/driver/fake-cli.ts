import type { Cli, CliProcess, CliResult } from './cli.ts'
import { FakeIsolation } from './fake-isolation.ts'

export class FakeProcess implements CliProcess {
  readonly result: Promise<CliResult>
  killed = false
  isolation = false
  #resolve: (result: CliResult) => void
  #reject: (error: Error) => void

  constructor() {
    const deferred = Promise.withResolvers<CliResult>()
    this.result = deferred.promise
    this.#resolve = deferred.resolve
    this.#reject = deferred.reject
  }

  complete(result: Partial<CliResult> = {}): void {
    this.#resolve({ code: 0, stdout: '', stderr: '', ...result })
  }

  fail(error: Error): void {
    this.#reject(error)
  }

  kill(): void {
    this.killed = true
  }
}

type Response = { match: RegExp } & ({ result: Partial<CliResult> } | { error: Error })

export class FakeCli implements Cli {
  readonly isolation = new FakeIsolation()
  readonly started: { args: string[]; proc: FakeProcess; seq: number }[] = []
  readonly responses: Response[] = []

  start(args: readonly string[]): FakeProcess {
    const proc = new FakeProcess()
    const isolated = this.isolation.respond(args)
    if (isolated) {
      proc.isolation = true
      proc.complete(isolated)
      return proc
    }
    this.started.push({ args: [...args], proc, seq: this.started.length })
    const response = this.responses.find(({ match }) => match.test(args.join(' ')))
    if (response) {
      if ('error' in response) proc.fail(response.error)
      else proc.complete(response.result)
    }
    return proc
  }

  joined(): string[] {
    return this.started.map(({ args }) => args.join(' '))
  }
}
