import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import {
  nativeCli,
  endedBySignal,
  outputLimit,
  diagnosticLimit,
  type Cli,
  type CliProcess,
  type CliResult,
} from './cli.ts'
import { createEvents, type InventoryChange } from './events.ts'
import { endForeignWaits, listingFormat, parseListing, type ListedContainer } from './listing.ts'

export type ContainerSpec = {
  sessionId: string
  containerId: string
  image: string
  env: Record<string, string>
  mounts: { hostPath: string; containerPath: string; readonly: boolean }[]
  network: { kind: 'default' } | { kind: 'lockdown'; dockerNetwork: string }
  limits: { cpus: number; memoryMb: number; pids: number }
}
export type ContainerDriver = {
  run(spec: ContainerSpec): Promise<{ ok: true } | { ok: false; reason: string }>
  kill(containerId: string, graceMs: number): Promise<void>
  onExit(listener: (containerId: string, code: number) => void): () => void
}

export type ContainerInventory = {
  sweep(): Promise<ListedContainer[]>
  adopt(container: ListedContainer): RunResult
  remove(container: ListedContainer): Promise<void>
  nameOf(containerId: string): string
  watch(listener: (change: InventoryChange) => void): () => void
}

type RunResult = Awaited<ReturnType<ContainerDriver['run']>>
type Creation = {
  result: Promise<CliResult>
  state: 'pending' | 'settled' | 'unconfirmed'
  endedAt: number | undefined
  cancel(): void
}
type Address = { by: 'name' | 'id'; value: string }
type AgentContainer = {
  sessionId: string
  containerId: string
  name: string
  address: Address
  ownership: 'uncertain' | 'confirmed' | 'absent'
  phase: 'starting' | 'running' | 'stopping' | 'failed'
  create: Creation | undefined
  processes: Set<CliProcess>
  removal: Promise<void> | undefined
  cancelled: boolean
  emitted: boolean
}
type AgentOperation = AgentContainer & {
  pending: Promise<RunResult>
  watch: Promise<void> | undefined
}

class CleanupError extends Error {
  readonly cleanupFailed = true
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
  revision?: string
  image: string
  network?: string
  timeoutMs?: number
  cli?: Cli
}): ContainerDriver &
  ContainerInventory & {
    probe(url: string, options?: { signal?: AbortSignal }): Promise<string>
    stop(): Promise<void>
    detach(): Promise<void>
  } {
  const cli = options.cli ?? nativeCli
  const revision = options.revision ?? null
  const timeoutMs = options.timeoutMs ?? 10_000
  const error = (message: string, cause?: unknown) =>
    new Error(`Docker (${options.image}): ${message}`, { cause })
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw error('timeoutMs must be a positive integer no greater than 2147483647')
  }
  let owned:
    | { name: string; kind: 'uncertain' | 'confirmed' | 'absent'; create: Creation | undefined }
    | undefined
  let active = false

  function normalize(operation: string, cause: unknown): Error {
    return error(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
  }

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

  const agents = new Map<string, AgentOperation>()
  const replacements = new Map<string, AgentOperation>()
  const residue = new Map<string, AgentContainer>()
  const work = new Set<Promise<unknown>>()
  const listeners = new Set<(containerId: string, code: number) => void>()
  const shutdown = new AbortController()
  const commands = new Set<CliProcess>()
  const detached = new Set<AgentContainer>()
  const adoptedWaits = new Set<string>()
  let waitScan: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  function record(
    identity: Pick<AgentContainer, 'sessionId' | 'containerId' | 'name' | 'ownership' | 'phase'>,
    address: Address = { by: 'name', value: identity.name },
  ): AgentOperation {
    return {
      ...identity,
      address,
      create: undefined,
      processes: new Set(),
      removal: undefined,
      cancelled: false,
      emitted: false,
      pending: Promise.resolve({ ok: false, reason: 'not started' }),
      watch: undefined,
    }
  }

  function agentName(containerId: string): string {
    return `kurumi-agent-${createHash('sha256').update(options.install).update('\0').update(containerId).digest('hex').slice(0, 32)}`
  }

  async function agentCommand(
    args: readonly string[],
    operation?: AgentContainer,
  ): Promise<CliResult> {
    let proc: CliProcess
    try {
      proc = cli.start(args)
    } catch {
      throw error(`${args[0]} failed`)
    }
    const lastsWithContainer = args[0] === 'wait' || args[0] === 'create'
    const deadline = lastsWithContainer ? undefined : setTimeout(() => proc.kill(), timeoutMs)
    const tracked = operation?.processes ?? commands
    const create = args[0] === 'create' && operation ? settleCreate(proc) : undefined
    if (create && operation) operation.create = create
    else tracked.add(proc)
    try {
      const exit = await (create?.result ?? proc.result)
      if (Buffer.byteLength(exit.stdout) > outputLimit)
        throw error(`${args[0]} output exceeds limit`)
      return exit
    } catch {
      throw error(`${args[0]} failed`)
    } finally {
      clearTimeout(deadline)
      tracked.delete(proc)
    }
  }

  function requireSuccess(exit: CliResult, operation: string): string {
    if (exit.code !== 0)
      throw error(
        `${operation}: ${exit.code === null ? 'terminated by signal' : `exit ${exit.code}`}`,
      )
    return exit.stdout
  }

  function removeAgent(agent: AgentContainer): Promise<void> {
    if (agent.removal) return agent.removal
    agent.cancelled = true
    agent.phase = 'stopping'
    agent.create?.cancel()
    for (const proc of agent.processes) proc.kill()
    const joining = [...agent.processes].map((proc) => proc.result.catch(() => {}))
    agent.removal = Promise.resolve()
      .then(async () => {
        await Promise.all(joining)
        await agent.create?.result.catch(() => {})
        if (agent.create?.state === 'unconfirmed') throw error('agent create cleanup unconfirmed')
        let removed = false
        let removing = false
        try {
          const exit = await agentCommand(['rm', '--force', agent.address.value], agent)
          removing =
            exit.code !== 0 &&
            /^(?:Error response from daemon: )?removal (?:of container [^\r\n]+ is )?already in progress\s*$/.test(
              exit.stderr,
            )
          removed =
            (exit.code === 0 &&
              (agent.ownership !== 'uncertain' || exit.stdout.trim() === agent.address.value)) ||
            (exit.code !== 0 &&
              /^(?:Error response from daemon: )?No such container(?:: [^\r\n]+)?\s*$/.test(
                exit.stderr,
              ))
        } catch {
          removed = false
        }
        if (!removed) {
          const deadline = performance.now() + timeoutMs
          const { by, value } = agent.address
          const filter = by === 'id' ? `id=${value}` : `name=^/${value}$`
          while (true) {
            const exit = await agentCommand(
              ['ps', '-a', '--filter', filter, '--format', '{{.Names}}'],
              agent,
            )
            const names = requireSuccess(exit, 'confirm removal')
            if (names.trim() === '') break
            const remaining = deadline - performance.now()
            if (!removing || remaining <= 0) throw error('agent cleanup unconfirmed')
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
          }
        }
        agent.ownership = 'absent'
        if (agents.get(agent.sessionId) === agent) agents.delete(agent.sessionId)
        if (agent.address.by === 'id') residue.delete(agent.address.value)
      })
      .catch((cause: unknown) => {
        agent.phase = 'failed'
        throw cause
      })
      .finally(() => {
        agent.removal = undefined
      })
    return agent.removal
  }

  function emitExit(agent: AgentOperation, code: number): void {
    if (agent.emitted) return
    agent.emitted = true
    for (const listener of listeners) {
      try {
        listener(agent.containerId, code)
      } catch {}
    }
  }

  async function watchAgent(agent: AgentOperation): Promise<void> {
    let code = -1
    try {
      const exit = await agentCommand(['wait', agent.name], agent)
      const value = requireSuccess(exit, 'wait').trim()
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw error('invalid wait exit code')
      code = Number(value)
    } catch {
      code = -1
    }
    if (detached.has(agent)) return
    emitExit(agent, code)
    try {
      await removeAgent(agent)
    } catch {}
  }

  async function startAgent(agent: AgentOperation, spec: ContainerSpec): Promise<RunResult> {
    try {
      if (agent.cancelled || shutdown.signal.aborted)
        return { ok: false, reason: error('run cancelled').message }
      const exit = await agentCommand(
        [
          'create',
          '--name',
          agent.name,
          '--label',
          `kurumi.install=${options.install}`,
          '--label',
          `kurumi.session=${spec.sessionId}`,
          '--label',
          'kurumi.role=agent',
          '--label',
          `kurumi.container=${spec.containerId}`,
          ...(revision === null ? [] : ['--label', `kurumi.revision=${revision}`]),
          '--init',
          '--cap-drop=ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          String(spec.limits.cpus),
          '--memory',
          `${spec.limits.memoryMb}m`,
          '--pids-limit',
          String(spec.limits.pids),
          '--network',
          spec.network.kind === 'lockdown'
            ? spec.network.dockerNetwork
            : (options.network ?? 'bridge'),
          '--pull',
          'never',
          ...(process.platform === 'linux'
            ? ['--add-host', 'host.docker.internal:host-gateway']
            : []),
          ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
          ...spec.mounts.flatMap((mount) => [
            '--volume',
            `${mount.hostPath}:${mount.containerPath}:${mount.readonly ? 'ro' : 'rw'}`,
          ]),
          spec.image,
          'bun',
          '/app/runner.js',
        ],
        agent,
      )
      if (exit.code === 0) agent.ownership = 'confirmed'
      requireSuccess(exit, 'create')
      if (agent.cancelled || shutdown.signal.aborted) throw error('run cancelled')
      requireSuccess(await agentCommand(['start', agent.name], agent), 'start')
      if (agent.cancelled || shutdown.signal.aborted) throw error('run cancelled')
      agent.phase = 'running'
      agent.watch = watchAgent(agent)
      return { ok: true }
    } catch (cause) {
      let reason = cause instanceof Error ? cause.message : error('run failed').message
      try {
        await removeAgent(agent)
      } catch {
        reason += '; agent cleanup unconfirmed'
      }
      return { ok: false, reason }
    }
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

  function track<T>(pending: Promise<T>): Promise<T> {
    work.add(pending)
    return pending.finally(() => {
      work.delete(pending)
    })
  }

  async function listContainers(filters: readonly string[]): Promise<ListedContainer[]> {
    const exit = await agentCommand([
      'ps',
      '-a',
      '--no-trunc',
      ...filters.flatMap((filter) => ['--filter', filter]),
      '--format',
      listingFormat,
    ])
    return requireSuccess(exit, 'list')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const container = parseListing(line)
        if (!container) throw error('invalid container listing')
        return container
      })
  }

  function removeListed(container: ListedContainer, containerId: string): Promise<void> {
    const { dockerId, name } = container
    const listed = residue.get(dockerId) ?? {
      ...record(
        { sessionId: '', containerId, name, ownership: 'confirmed', phase: 'stopping' },
        { by: 'id', value: dockerId },
      ),
      cancelled: true,
    }
    residue.set(dockerId, listed)
    return removeAgent(listed)
  }

  const { watch, endWatch } = createEvents({
    cli,
    install: options.install,
    signal: shutdown.signal,
    track,
    error,
  })

  function close({ keepRunning }: { keepRunning: boolean }): Promise<void> {
    if (stopping) return stopping
    shutdown.abort()
    endWatch()
    for (const proc of commands) proc.kill()
    if (keepRunning)
      for (const agent of agents.values())
        if (agent.phase === 'running') {
          detached.add(agent)
          for (const proc of agent.processes) proc.kill()
        }
    const removals = [...agents.values(), ...residue.values()]
      .filter((agent) => !detached.has(agent))
      .map((agent) => removeAgent(agent))
    const watches = [...agents.values()].map((agent) => agent.watch)
    stopping = Promise.allSettled([
      ...removals,
      ...watches,
      ...work,
      ...[...commands].map((proc) => proc.result),
    ]).then(async () => {
      await cleanup()
      if ([...agents.values()].some((agent) => !detached.has(agent)) || residue.size > 0 || owned)
        throw error('shutdown cleanup unconfirmed')
    })
    return stopping
  }

  return {
    run(spec) {
      if (shutdown.signal.aborted)
        return Promise.resolve({ ok: false, reason: error('driver stopped').message })
      if (spec.mounts.some((mount) => !existsSync(mount.hostPath)))
        return Promise.resolve({ ok: false, reason: error('mount source does not exist').message })
      const existing = agents.get(spec.sessionId)
      if (existing && (existing.phase === 'starting' || existing.phase === 'running'))
        return existing.pending
      if (
        [...agents.values()].some(
          (agent) => agent.containerId === spec.containerId && agent.sessionId !== spec.sessionId,
        )
      )
        return Promise.resolve({
          ok: false,
          reason: error('container id belongs to another session').message,
        })
      const agent = record({
        sessionId: spec.sessionId,
        containerId: spec.containerId,
        name: agentName(spec.containerId),
        ownership: 'uncertain',
        phase: 'starting',
      })
      if (existing) {
        const removal = removeAgent(existing)
        existing.phase = 'starting'
        replacements.set(agent.containerId, agent)
        agent.pending = removal
          .then(
            () => {
              if (shutdown.signal.aborted || agent.cancelled)
                return { ok: false, reason: error('run cancelled').message } satisfies RunResult
              agents.set(spec.sessionId, agent)
              return startAgent(agent, spec)
            },
            () => ({ ok: false, reason: error('agent cleanup unconfirmed').message }),
          )
          .finally(() => {
            replacements.delete(agent.containerId)
          })
        existing.pending = agent.pending
      } else {
        agents.set(spec.sessionId, agent)
        agent.pending = Promise.resolve().then(() => startAgent(agent, spec))
      }
      return track(agent.pending)
    },
    kill(containerId, graceMs) {
      if (shutdown.signal.aborted)
        return stopping ?? Promise.reject(error('shutdown cleanup has not completed'))
      return track(
        (async () => {
          const replacement = replacements.get(containerId)
          if (replacement) {
            replacement.cancelled = true
            replacement.create?.cancel()
            for (const proc of replacement.processes) proc.kill()
            await replacement.pending
            if (replacement.create && replacement.ownership !== 'absent')
              throw error('agent cleanup unconfirmed')
            return
          }
          const agent = [...agents.values()].find(
            (candidate) => candidate.containerId === containerId,
          )
          if (agent) {
            if (agent.phase === 'running' && graceMs > 0) {
              try {
                requireSuccess(
                  await agentCommand(
                    ['stop', '--time', String(Math.ceil(graceMs / 1000)), agent.name],
                    agent,
                  ),
                  'stop',
                )
              } catch {}
            }
            await removeAgent(agent)
            await agent.pending
            await agent.watch
            return
          }
          const listed = await listContainers([
            `label=kurumi.install=${options.install}`,
            'label=kurumi.role=agent',
            `label=kurumi.container=${containerId}`,
          ])
          for (const container of listed) await removeListed(container, containerId)
        })(),
      )
    },
    sweep() {
      if (shutdown.signal.aborted) return Promise.reject(error('driver stopped'))
      return track(
        (async () => {
          const listedAt = performance.now()
          const listed = await listContainers([`label=kurumi.install=${options.install}`])
          const tracked = [...agents.values(), ...replacements.values(), ...residue.values()]
          for (const create of [owned?.create, ...tracked.map((agent) => agent.create)])
            if (create?.state === 'unconfirmed' && (create.endedAt ?? Infinity) <= listedAt)
              create.state = 'settled'
          return listed.filter(
            ({ name, dockerId }) =>
              name !== owned?.name && residue.get(dockerId)?.removal === undefined,
          )
        })(),
      )
    },
    adopt(container) {
      const { name, sessionId, containerId } = container
      if (shutdown.signal.aborted) return { ok: false, reason: error('driver stopped').message }
      if (sessionId === null || containerId === null || name !== agentName(containerId))
        return { ok: false, reason: error('container name does not match its labels').message }
      if (container.revision !== revision)
        return { ok: false, reason: error('container was created for another runtime').message }
      if (agents.has(sessionId))
        return { ok: false, reason: error('session already has a container').message }
      const agent = {
        ...record({ sessionId, containerId, name, ownership: 'confirmed', phase: 'running' }),
        pending: Promise.resolve<RunResult>({ ok: true }),
      }
      agents.set(sessionId, agent)
      agent.watch = watchAgent(agent)
      adoptedWaits.add(name)
      waitScan ??= track(
        Promise.resolve().then(() => {
          const names = new Set(adoptedWaits)
          adoptedWaits.clear()
          waitScan = undefined
          return endForeignWaits(names)
        }),
      ).catch(() => {})
      return { ok: true }
    },
    remove(container) {
      if (shutdown.signal.aborted) return Promise.reject(error('driver stopped'))
      return track(removeListed(container, ''))
    },
    nameOf: agentName,
    watch,
    onExit(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    probe(url, { signal } = {}) {
      if (shutdown.signal.aborted) return Promise.reject(error('driver stopped'))
      return track(
        probe(url, {
          signal: signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
        }),
      )
    },
    stop: () => close({ keepRunning: false }),
    detach: () => close({ keepRunning: true }),
  }
}
