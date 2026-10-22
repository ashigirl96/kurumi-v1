import { expect, test } from 'bun:test'

import { createDockerDriver } from '../server.ts'
import { FakeCli } from './fake-cli.ts'

const image = 'kurumi-agent:test'
const url = 'http://host.docker.internal:1234/probe/fresh-nonce'

function setup() {
  const cli = new FakeCli()
  const driver = createDockerDriver({ install: 'test-install', image, cli })
  return { cli, driver }
}

async function call(cli: FakeCli, index: number) {
  for (let turn = 0; turn < 30; turn++) {
    const result = cli.started[index]
    if (result) return result
    await Bun.sleep(5)
  }
  throw new Error(`Docker call ${index} was never started: ${cli.joined().join('; ')}`)
}

function observe(promise: Promise<string>) {
  return promise.then(
    (body) => ({ kind: 'success', body }) as const,
    (error: unknown) => ({ kind: 'failure', error }) as const,
  )
}

async function rejection(promise: Promise<string>): Promise<string> {
  const outcome = await observe(promise)
  expect(outcome.kind).toBe('failure')
  if (outcome.kind === 'success') throw new Error('probe unexpectedly succeeded')
  expect(outcome.error).toBeInstanceOf(Error)
  if (!(outcome.error instanceof Error)) throw new Error('probe rejected without an Error')
  return outcome.error.message
}

test('probe returns the raw response only after its container has been removed', async () => {
  const { cli, driver } = setup()
  cli.responses.push(
    { match: /^create /, result: { stdout: 'container-id\n' } },
    { match: /^start /, result: { stdout: ' fresh-nonce\n' } },
    { match: /^rm /, result: {} },
  )
  expect(await driver.probe(url)).toBe(' fresh-nonce\n')
  expect(cli.started.map(({ args }) => args[0])).toEqual(['create', 'start', 'rm'])
  const create = await call(cli, 0)
  expect(create.args).toContain('--rm')
  expect(create.args).toContain('--init')
  expect(create.args).toContain('kurumi.install=test-install')
  expect(create.args).toContain('kurumi.role=probe')
  expect(
    create.args.slice(create.args.indexOf('--pull'), create.args.indexOf('--pull') + 2),
  ).toEqual(['--pull', 'never'])
  expect(
    create.args.slice(create.args.indexOf('--network'), create.args.indexOf('--network') + 2),
  ).toEqual(['--network', 'bridge'])
  expect(create.args).toContain(image)
  expect(create.args.at(-1)).toBe(url)
  const name = create.args[create.args.indexOf('--name') + 1]
  if (!name) throw new Error('probe has no container name')
  expect(cli.started[1]?.args).toEqual(['start', '--attach', name])
  expect(cli.started[2]?.args).toEqual(['rm', '--force', name])
})

test('network is configurable and every probe gets a unique name', async () => {
  const cli = new FakeCli()
  cli.responses.push({ match: /.*/, result: {} })
  const driver = createDockerDriver({ install: 'test', image, network: 'none', cli })
  await driver.probe(url)
  await driver.probe(url)
  const creates = cli.started.filter(({ args }) => args[0] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[0]?.args).toContain('none')
  expect(creates[0]?.args).not.toEqual(creates[1]?.args)
})

test.each([1, 125, 127, null])(
  'attach exit %s fails with Docker and image diagnostics',
  async (code) => {
    const { cli, driver } = setup()
    cli.responses.push(
      { match: /^create /, result: {} },
      { match: /^start /, result: { code, stderr: 'fetch failed' } },
      { match: /^rm /, result: {} },
    )
    expect(await rejection(driver.probe(url))).toContain(`Docker (${image})`)
    expect(cli.joined().at(-1)).toStartWith('rm --force ')
  },
)

test.each(['', 'Error response from daemon: '])(
  'missing image rejection %s permits retry after the image is built',
  async (prefix) => {
    const { cli, driver } = setup()
    cli.responses.push(
      {
        match: /^create /,
        result: { code: 125, stderr: `${prefix}No such image: kurumi-agent:test\n` },
      },
      { match: /^rm /, result: {} },
    )
    expect(await rejection(driver.probe(url))).toContain('No such image')
    expect(cli.started.map(({ args }) => args[0])).toEqual(['create', 'rm'])
    cli.responses.splice(0, 1, { match: /^create /, result: {} })
    cli.responses.push({ match: /^start /, result: { stdout: 'fresh-nonce' } })
    expect(await driver.probe(url)).toBe('fresh-nonce')
    expect(cli.started.map(({ args }) => args[0])).toEqual([
      'create',
      'rm',
      'create',
      'start',
      'rm',
    ])
  },
)

test('spawn failure is normalized and cannot bypass cleanup', async () => {
  const { cli, driver } = setup()
  cli.responses.push(
    {
      match: /^create /,
      error: Object.assign(new Error('spawn docker ENOENT'), {
        code: 'ENOENT',
        syscall: 'spawn docker',
      }),
    },
    { match: /^rm /, result: {} },
  )
  const outcome = await observe(driver.probe(url))
  expect(outcome.kind).toBe('failure')
  if (outcome.kind !== 'failure') throw new Error('probe unexpectedly succeeded')
  expect(String(outcome.error)).toContain(`Docker (${image}): create: spawn docker ENOENT`)
  expect(outcome.error).not.toHaveProperty('cleanupFailed')
  expect(cli.started.map(({ args }) => args[0])).toEqual(['create', 'rm'])
})

test('a signal aborted before probe allocates no container', async () => {
  const { cli, driver } = setup()
  expect(await rejection(driver.probe(url, { signal: AbortSignal.abort() }))).toContain('abort')
  expect(cli.started).toHaveLength(0)
})

test.each(['success', 'failure'])(
  'abort kills create and joins its late %s before cleanup',
  async (late) => {
    const { cli, driver } = setup()
    const abort = new AbortController()
    let settled = false
    const outcome = observe(driver.probe(url, { signal: abort.signal })).finally(() => {
      settled = true
    })
    const create = await call(cli, 0)
    abort.abort()
    expect(create.proc.killed).toBe(true)
    expect(settled).toBe(false)
    expect(cli.started).toHaveLength(1)
    if (late === 'success') create.proc.complete({ stdout: 'late-container' })
    else create.proc.fail(new Error('late create failure'))
    const removal = await call(cli, 1)
    expect(removal.args[0]).toBe('rm')
    expect(settled).toBe(false)
    removal.proc.complete({ code: 1, stderr: 'No such container' })
    const failed = await outcome
    expect(failed.kind).toBe('failure')
    if (failed.kind === 'failure') expect(failed.error).not.toHaveProperty('cleanupFailed')
    expect(cli.started.map(({ args }) => args[0])).toEqual(['create', 'rm'])
  },
)

test('abort during attach removes the container and joins the killed child before rejecting', async () => {
  const { cli, driver } = setup()
  const abort = new AbortController()
  let settled = false
  const outcome = observe(driver.probe(url, { signal: abort.signal })).finally(() => {
    settled = true
  })
  ;(await call(cli, 0)).proc.complete()
  const attach = await call(cli, 1)
  abort.abort()
  const removal = await call(cli, 2)
  expect(removal.args[0]).toBe('rm')
  expect(attach.proc.killed).toBe(true)
  removal.proc.complete()
  await Promise.resolve()
  expect(settled).toBe(false)
  attach.proc.complete({ code: null })
  expect((await outcome).kind).toBe('failure')
})

test('cleanup is a barrier for success and overlapping probes are rejected', async () => {
  const { cli, driver } = setup()
  let settled = false
  const outcome = driver.probe(url).finally(() => {
    settled = true
  })
  ;(await call(cli, 0)).proc.complete()
  ;(await call(cli, 1)).proc.complete({ stdout: 'fresh-nonce' })
  const removal = await call(cli, 2)
  expect(await rejection(driver.probe(url))).toContain('progress')
  expect(settled).toBe(false)
  expect(cli.started).toHaveLength(3)
  removal.proc.complete()
  expect(await outcome).toBe('fresh-nonce')
})

test('an auto-removed container is absent after a successful exact-name query', async () => {
  const { cli, driver } = setup()
  cli.responses.push(
    { match: /^create /, result: {} },
    { match: /^start /, result: { stdout: 'fresh-nonce' } },
    { match: /^rm /, result: { code: 1, stderr: 'container removal failed' } },
    { match: /^ps /, result: { stdout: '' } },
  )
  expect(await driver.probe(url)).toBe('fresh-nonce')
  const create = await call(cli, 0)
  const name = create.args[create.args.indexOf('--name') + 1]
  expect(cli.started[3]?.args).toEqual([
    'ps',
    '-a',
    '--filter',
    `name=^/${name}$`,
    '--format',
    '{{.Names}}',
  ])
})

test('cleanup failure survives success and is retried before any replacement container', async () => {
  const { cli, driver } = setup()
  const outcome = observe(driver.probe(url))
  ;(await call(cli, 0)).proc.complete()
  ;(await call(cli, 1)).proc.complete({ stdout: 'fresh-nonce' })
  const removal = await call(cli, 2)
  removal.proc.complete({ code: 1, stderr: 'daemon unavailable' })
  ;(await call(cli, 3)).proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
  const failure = await outcome
  expect(failure.kind).toBe('failure')
  if (failure.kind === 'failure') expect(String(failure.error)).toContain('cleanup')
  const retry = observe(driver.probe(url))
  const secondRemoval = await call(cli, 4)
  expect(secondRemoval.args).toEqual(removal.args)
  expect(cli.started.filter(({ args }) => args[0] === 'create')).toHaveLength(1)
  secondRemoval.proc.complete({ code: 1, stderr: 'still unavailable' })
  ;(await call(cli, 5)).proc.complete({ code: 1, stderr: 'still unavailable' })
  expect((await retry).kind).toBe('failure')
  const recovered = driver.probe(url)
  const thirdRemoval = await call(cli, 6)
  expect(thirdRemoval.args).toEqual(removal.args)
  thirdRemoval.proc.complete()
  const nextCreate = await call(cli, 7)
  expect(nextCreate.args[0]).toBe('create')
  nextCreate.proc.complete()
  ;(await call(cli, 8)).proc.complete({ stdout: 'new-nonce' })
  ;(await call(cli, 9)).proc.complete()
  expect(await recovered).toBe('new-nonce')
})

test('an ambiguous create error and Docker outage retain the same owned name', async () => {
  const { cli, driver } = setup()
  const outcome = observe(driver.probe(url))
  ;(await call(cli, 0)).proc.fail(new Error('connection lost during create'))
  const removal = await call(cli, 1)
  removal.proc.fail(new Error('daemon offline'))
  ;(await call(cli, 2)).proc.fail(new Error('daemon offline'))
  const failure = await outcome
  expect(failure.kind).toBe('failure')
  if (failure.kind === 'failure') {
    expect(String(failure.error)).toContain('connection lost during create')
    expect(String(failure.error)).toContain('cleanup')
  }
  const retry = observe(driver.probe(url))
  expect((await call(cli, 3)).args).toEqual(removal.args)
  ;(await call(cli, 3)).proc.complete({ code: 1 })
  ;(await call(cli, 4)).proc.complete({ code: 1 })
  await retry
  expect(cli.started.filter(({ args }) => args[0] === 'create')).toHaveLength(1)
})

test.each(['no such container', 'empty query', 'empty removal', 'different removal name'])(
  'failed create cleanup confirms absence through %s without retaining a cleanup failure',
  async (absence) => {
    const { cli, driver } = setup()
    const outcome = observe(driver.probe(url))
    const create = await call(cli, 0)
    const name = create.args[create.args.indexOf('--name') + 1]
    create.proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
    if (absence === 'no such container') cli.responses.push({ match: /^ps /, result: {} })
    ;(await call(cli, 1)).proc.complete({
      code: absence === 'no such container' || absence === 'empty query' ? 1 : 0,
      stderr: absence === 'no such container' ? `No such container: ${name}` : '',
      stdout: absence === 'different removal name' ? 'other-container\n' : '',
    })
    if (absence !== 'no such container') (await call(cli, 2)).proc.complete()
    const failed = await outcome
    expect(failed.kind).toBe('failure')
    if (failed.kind === 'failure') expect(failed.error).not.toHaveProperty('cleanupFailed')
  },
)

test('empty removal cannot release an uncertain name while Docker cannot confirm absence', async () => {
  const { cli, driver } = setup()
  const outcome = observe(driver.probe(url))
  ;(await call(cli, 0)).proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
  const removal = await call(cli, 1)
  removal.proc.complete()
  ;(await call(cli, 2)).proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
  const failed = await outcome
  if (failed.kind !== 'failure') throw new Error('probe unexpectedly succeeded')
  expect(failed.error).toHaveProperty('cleanupFailed', true)
  const retry = observe(driver.probe(url))
  const retriedRemoval = await call(cli, 3)
  expect(retriedRemoval.args).toEqual(removal.args)
  retriedRemoval.proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
  ;(await call(cli, 4)).proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
  expect((await retry).kind).toBe('failure')
  expect(cli.started.filter(({ args }) => args[0] === 'create')).toHaveLength(1)
})

test.each(['no such container', 'empty query', 'empty removal', 'different removal name'])(
  'Docker recovery confirms uncertain name absence through %s and permits a fresh probe',
  async (absence) => {
    const { cli, driver } = setup()
    const first = observe(driver.probe(url))
    const create = await call(cli, 0)
    const name = create.args[create.args.indexOf('--name') + 1]
    if (!name) throw new Error('probe has no container name')
    create.proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
    const removal = await call(cli, 1)
    removal.proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
    ;(await call(cli, 2)).proc.complete({ code: 1, stderr: 'Cannot connect to Docker' })
    const failed = await first
    expect(failed.kind).toBe('failure')
    if (failed.kind !== 'failure') throw new Error('probe unexpectedly succeeded')
    expect(failed.error).toHaveProperty('cleanupFailed', true)
    expect(String(failed.error)).toContain(name)

    const retryIndex = cli.started.length
    const retry = observe(driver.probe(url))
    const retryRemoval = await call(cli, retryIndex)
    expect(retryRemoval.args).toEqual(removal.args)
    if (absence === 'no such container') cli.responses.push({ match: /^ps /, result: {} })
    retryRemoval.proc.complete({
      code: absence === 'no such container' || absence === 'empty query' ? 1 : 0,
      stderr:
        absence === 'no such container'
          ? `Error response from daemon: No such container: ${name}`
          : '',
      stdout: absence === 'different removal name' ? 'other-container\n' : '',
    })
    let next = retryIndex + 1
    if (absence !== 'no such container') {
      ;(await call(cli, next++)).proc.complete()
    }
    const replacement = await call(cli, next++)
    expect(replacement.args[0]).toBe('create')
    expect(replacement.args).not.toContain(name)
    replacement.proc.complete()
    ;(await call(cli, next++)).proc.complete({ stdout: 'new-nonce' })
    ;(await call(cli, next)).proc.complete()
    expect(await retry).toEqual({ kind: 'success', body: 'new-nonce' })
  },
)

test('removal already in progress waits through a listed container until it disappears', async () => {
  const { cli, driver } = setup()
  const outcome = observe(driver.probe(url))
  const create = await call(cli, 0)
  const name = create.args[create.args.indexOf('--name') + 1]
  create.proc.complete()
  ;(await call(cli, 1)).proc.complete({ stdout: 'fresh-nonce' })
  ;(await call(cli, 2)).proc.complete({
    code: 1,
    stderr: `Error response from daemon: removal of container ${name} is already in progress`,
  })
  ;(await call(cli, 3)).proc.complete({ stdout: `${name}\n` })
  ;(await call(cli, 4)).proc.complete()
  expect(await outcome).toEqual({ kind: 'success', body: 'fresh-nonce' })
})

test.each(['permission denied', 'removal already in progress'])(
  'cleanup retains ownership when the container remains after %s',
  async (stderr) => {
    const cli = new FakeCli()
    const driver = createDockerDriver({ install: 'test', image, timeoutMs: 30, cli })
    const outcome = observe(driver.probe(url))
    const create = await call(cli, 0)
    const name = create.args[create.args.indexOf('--name') + 1]
    create.proc.complete()
    ;(await call(cli, 1)).proc.complete({ stdout: 'fresh-nonce' })
    cli.responses.push({ match: /^ps /, result: { stdout: `${name}\n` } })
    ;(await call(cli, 2)).proc.complete({ code: 1, stderr })
    const failure = await outcome
    expect(failure.kind).toBe('failure')
    if (failure.kind === 'failure') {
      expect(failure.error).toBeInstanceOf(Error)
      expect(failure.error).toHaveProperty('cleanupFailed', true)
    }
    const retry = observe(driver.probe(url))
    const retriedRemoval = await call(cli, cli.started.length - 1)
    expect(retriedRemoval.args).toEqual(['rm', '--force', name])
    retriedRemoval.proc.complete({ code: 1, stderr: 'permission denied' })
    expect((await retry).kind).toBe('failure')
    expect(cli.started.filter(({ args }) => args[0] === 'create')).toHaveLength(1)
  },
)

test('ordinary failures do not claim cleanup failed', async () => {
  const { cli, driver } = setup()
  cli.responses.push(
    { match: /^create /, result: {} },
    { match: /^start /, result: { code: 1, stderr: 'fetch refused' } },
    { match: /^rm /, result: {} },
  )
  const outcome = await observe(driver.probe(url))
  expect(outcome.kind).toBe('failure')
  if (outcome.kind === 'failure') {
    expect(String(outcome.error)).toContain('fetch refused')
    expect(outcome.error).not.toHaveProperty('cleanupFailed')
  }
})

test('synchronously failing process start is normalized and cleaned up', async () => {
  const cli = new FakeCli()
  const driver = createDockerDriver({
    install: 'test',
    image,
    cli: {
      start(args) {
        if (args[0] === 'create')
          throw Object.assign(new Error('cannot spawn docker'), {
            code: 'ENOENT',
            syscall: 'spawn docker',
          })
        return cli.start(args)
      },
    },
  })
  cli.responses.push({ match: /^rm /, result: {} })
  const outcome = await observe(driver.probe(url))
  expect(outcome.kind).toBe('failure')
  if (outcome.kind !== 'failure') throw new Error('probe unexpectedly succeeded')
  expect(String(outcome.error)).toContain(`Docker (${image}): create: cannot spawn docker`)
  expect(outcome.error).not.toHaveProperty('cleanupFailed')
  expect(cli.started[0]?.args[0]).toBe('rm')
})

test('oversized stdout fails rather than accepting a truncated proof', async () => {
  const { cli, driver } = setup()
  cli.responses.push(
    { match: /^create /, result: {} },
    { match: /^start /, result: { stdout: 'a'.repeat(64 * 1024 + 1) } },
    { match: /^rm /, result: {} },
  )
  expect(await rejection(driver.probe(url))).toContain('stdout exceeds')
  expect(cli.started.at(-1)?.args[0]).toBe('rm')
})

async function program(timeoutMs = 1000) {
  const cli = new FakeCli()
  cli.responses.push({ match: /.*/, result: {} })
  await createDockerDriver({ install: 'test', image, timeoutMs, cli }).probe(url)
  const create = await call(cli, 0)
  const script = create.args[create.args.indexOf('-e') + 1]
  if (!script) throw new Error('probe has no fetch program')
  return script
}

test('the container fetch program writes the exact body and refuses non-success HTTP', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === '/good'
        ? new Response(' exact-proof\n')
        : new Response('exact-proof', { status: 503 })
    },
  })
  try {
    const script = await program()
    const success = Bun.spawn([process.execPath, '-e', script, `${server.url}good`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const body = await new Response(success.stdout).text()
    expect(await success.exited).toBe(0)
    expect(body).toBe(' exact-proof\n')
    const failed = Bun.spawn([process.execPath, '-e', script, `${server.url}bad`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const diagnostic = await new Response(failed.stderr).text()
    expect(await failed.exited).not.toBe(0)
    expect(diagnostic).toContain('HTTP 503')
  } finally {
    await server.stop(true)
  }
})

test('the fetch deadline covers a stalled body as well as response headers', async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
          },
        }),
      )
    },
  })
  try {
    const child = Bun.spawn([process.execPath, '-e', await program(30), server.url.href], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const diagnostic = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(diagnostic).toMatch(/timeout|abort/i)
    expect(await new Response(child.stdout).text()).toBe('')
  } finally {
    await server.stop(true)
  }
})

test('the fetch program bounds the body before writing proof', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('a'.repeat(64 * 1024 + 1)) })
  try {
    const child = Bun.spawn([process.execPath, '-e', await program(), server.url.href], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await new Response(child.stderr).text()).toContain('probe response exceeds')
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stdout).text()).toBe('')
  } finally {
    await server.stop(true)
  }
})
