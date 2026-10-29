import { expect, test } from 'bun:test'

import type { Cli } from './cli.ts'
import { createDockerDriver, type ContainerSpec } from './docker.ts'
import { FakeCli, FakeProcess } from './fake-cli.ts'
import type { ListedContainer } from './listing.ts'

const image = 'agent-test'
const spec: ContainerSpec = {
  sessionId: 'session',
  containerId: 'generation',
  image,
  env: {},
  mounts: [],
  limits: { cpus: 1, memoryMb: 256, pids: 64 },
}

function setup() {
  const fake = new FakeCli()
  fake.responses.push({ match: /^(create|start|rm|ps) /, result: {} })
  const calls: string[][] = []
  let fault: ((args: readonly string[]) => boolean) | undefined
  const cli: Cli = {
    start(args) {
      calls.push([...args])
      if (fault?.(args)) {
        const proc = new FakeProcess()
        proc.complete({ code: 1, stderr: 'injected Docker failure' })
        return proc
      }
      const proc = fake.start(args)
      return {
        result: proc.result,
        kill() {
          proc.kill()
          proc.complete({ code: null })
        },
      }
    },
  }
  const options = { install: 'isolation-test', image, agentPort: 1234, cli, timeoutMs: 100 }
  const driver = createDockerDriver(options)
  const name = driver.nameOf(spec.containerId)
  function listed(): ListedContainer {
    const container = fake.isolation.containers.get(name)
    if (!container) throw new Error('runner absent')
    return {
      dockerId: container.Id,
      name,
      role: 'agent',
      sessionId: spec.sessionId,
      containerId: spec.containerId,
      revision: container.Config.Labels['kurumi.revision'] ?? null,
      state: 'running',
    }
  }
  return {
    fake,
    calls,
    options,
    driver,
    name,
    listed,
    fail: (predicate: typeof fault) => {
      fault = predicate
    },
  }
}

test('runner and probe use separate isolated networks with only a hardened fixed relay on the uplink', async () => {
  const { driver, fake, name } = setup()
  try {
    expect(await driver.run(spec)).toEqual({ ok: true })
    const network = fake.isolation.networks.get(`${name}-net`)
    expect(network).toMatchObject({
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    })
    const runner = fake.isolation.containers.get(name)
    const relay = fake.isolation.containers.get(`${name}-relay`)
    expect(Object.keys(runner?.NetworkSettings.Networks ?? {})).toEqual([`${name}-net`])
    expect(runner?.HostConfig.ExtraHosts).toEqual([])
    expect(relay?.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Sysctls: { 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' },
      PortBindings: {},
    })
    expect(relay?.Mounts).toEqual([])
    const resolved = fake.isolation.calls.findIndex((args) => args[0] === 'logs')
    const connected = fake.isolation.calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'connect',
    )
    expect(resolved).toBeLessThan(connected)
    await driver.probe('http://host.docker.internal:1234/probe')
    const probe = fake.started.find(({ args }) => args.includes('kurumi.role=probe'))?.args ?? []
    expect(probe).toContain('--cap-drop=ALL')
    expect(probe).toContain('no-new-privileges')
    expect(probe).not.toContain(`${name}-net`)
    expect(fake.isolation.networks.size).toBe(1)
  } finally {
    await driver.stop()
  }
  expect(fake.isolation.networks.size).toBe(0)
})

test.each(['network create', 'create relay', 'start relay', 'network connect', 'logs'])(
  'failure at %s never starts a runner or falls back to bridge',
  async (stage) => {
    const { driver, fake, fail } = setup()
    fail((args) =>
      stage === 'create relay'
        ? args[0] === 'create' && args.includes('kurumi.role=relay')
        : stage === 'start relay'
          ? args[0] === 'start' && !!args.at(-1)?.endsWith('-relay')
          : args.slice(0, stage.split(' ').length).join(' ') === stage,
    )
    expect((await driver.run(spec)).ok).toBe(false)
    expect(fake.started.some(({ args }) => args[0] === 'create')).toBe(false)
    fail(undefined)
    await driver.stop()
    expect(fake.isolation.networks.size).toBe(0)
    expect([...fake.isolation.containers.keys()].some((name) => name.endsWith('-relay'))).toBe(
      false,
    )
  },
)

test('detach preserves the whole group, fresh adoption validates it, and kill removes runner before relay before network', async () => {
  const { driver, fake, options, listed, calls, name } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  expect(fake.isolation.networks.size).toBe(1)
  expect(fake.isolation.containers.has(`${name}-relay`)).toBe(true)
  const next = createDockerDriver(options)
  expect(await next.adopt(listed())).toEqual({ ok: true })
  expect(await next.adopt(listed())).toEqual({ ok: true })
  const before = calls.length
  await next.kill(spec.containerId, 0)
  await next.stop()
  const removals = calls
    .slice(before)
    .filter((args) => args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'))
  expect(removals.map((args) => args[0])).toEqual(['rm', 'rm', 'network'])
  expect(removals[0]?.at(-1)).toBe(listed().dockerId)
  expect(fake.isolation.networks.size).toBe(0)
})

test.each([
  'missing relay',
  'uplink runner',
  'forwarding relay',
  'extra peer',
  'non-isolated network',
  'IPv6',
  'wrong command',
  'foreign relay',
  'privileged runner',
])('adoption rejects %s before watching the runner', async (defect) => {
  const { driver, fake, options, listed, name } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  const runner = fake.isolation.containers.get(name)!
  const relay = fake.isolation.containers.get(`${name}-relay`)!
  const network = fake.isolation.networks.get(`${name}-net`)!
  if (defect === 'missing relay') fake.isolation.containers.delete(`${name}-relay`)
  if (defect === 'uplink runner')
    runner.NetworkSettings.Networks.bridge = { IPAddress: '1.2.3.4', Aliases: [] }
  if (defect === 'forwarding relay') relay.HostConfig.Sysctls['net.ipv4.ip_forward'] = '1'
  if (defect === 'extra peer') network.Containers.foreign = {}
  if (defect === 'non-isolated network')
    network.Options['com.docker.network.bridge.gateway_mode_ipv4'] = 'nat'
  if (defect === 'IPv6') network.EnableIPv6 = true
  if (defect === 'wrong command') relay.Config.Cmd = ['bun', '-e', 'evil']
  if (defect === 'foreign relay') relay.Config.Labels['kurumi.install'] = 'foreign'
  if (defect === 'privileged runner') runner.HostConfig.Privileged = true
  const next = createDockerDriver(options)
  const before = fake.started.filter(({ args }) => args[0] === 'wait').length
  expect((await next.adopt(listed())).ok).toBe(false)
  expect(fake.started.filter(({ args }) => args[0] === 'wait')).toHaveLength(before)
  await next.stop()
})

test('Agent Port and isolation code participate in effective runtime revision', async () => {
  const { driver, options, listed } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  const next = createDockerDriver({ ...options, agentPort: 4321 })
  expect(await next.adopt(listed())).toMatchObject({
    ok: false,
    reason: expect.stringContaining('another runtime'),
  })
  expect(await next.adopt({ ...listed(), revision: null })).toMatchObject({ ok: false })
  await next.stop()
})

test('sweep removes orphan relay and network-only partial creates, not active relays', async () => {
  const { driver, fake, options, listed, name } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  const runner = listed()
  fake.responses.unshift({
    match: /^ps /,
    result: {
      stdout:
        JSON.stringify([
          runner.dockerId,
          name,
          'running',
          'agent',
          spec.sessionId,
          spec.containerId,
          runner.revision,
        ]) +
        '\n' +
        JSON.stringify(['f'.repeat(64), `${name}-relay`, 'running', 'relay', '', '', '']) +
        '\n',
    },
  })
  const next = createDockerDriver(options)
  expect(await next.sweep()).toEqual([runner])
  expect(fake.isolation.networks.size).toBe(1)
  fake.responses.shift()
  expect(await next.sweep()).toEqual([])
  expect(fake.isolation.networks.size).toBe(0)
  expect(fake.isolation.containers.has(`${name}-relay`)).toBe(false)
  await next.stop()
})

test('foreign relay name collision is never removed', async () => {
  const { driver, fake, options, name } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  fake.isolation.containers.get(`${name}-relay`)!.Config.Labels['kurumi.install'] = 'foreign'
  const next = createDockerDriver(options)
  expect((await next.run(spec)).ok).toBe(false)
  expect(await next.stop().then(() => 'ok', String)).toContain('cleanup')
  expect(fake.isolation.containers.has(`${name}-relay`)).toBe(true)
  expect(fake.started.filter(({ args }) => args[0] === 'rm')).toHaveLength(0)
})

test('network-only crash residue is removed on startup', async () => {
  const { driver, fake, options, name } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  fake.isolation.containers.clear()
  fake.isolation.networks.get(`${name}-net`)!.Containers = {}
  const next = createDockerDriver(options)
  expect(await next.sweep()).toEqual([])
  expect(fake.isolation.networks.size).toBe(0)
  await next.stop()
})

test('a failed network removal retains probe ownership and blocks replacement until cleanup succeeds', async () => {
  const { driver, fake, fail } = setup()
  fail((args) => args[0] === 'network' && args[1] === 'rm')
  const probe = () =>
    driver.probe('http://host.docker.internal:1234/probe').then(
      () => 'ok',
      (error) => error,
    )
  expect(await probe()).toHaveProperty('cleanupFailed', true)
  const creates = fake.started.filter(({ args }) => args[0] === 'create').length
  expect(await probe()).toHaveProperty('cleanupFailed', true)
  expect(fake.started.filter(({ args }) => args[0] === 'create')).toHaveLength(creates)
  fail(undefined)
  await driver.probe('http://host.docker.internal:1234/probe')
  await driver.stop()
  expect(fake.isolation.networks.size).toBe(0)
})

test.each(['agent', 'probe'])(
  'a foreign %s name collision never removes the foreign container',
  async (role) => {
    const { driver, fake } = setup()
    fake.responses.unshift({
      match: /^create /,
      result: {
        code: 125,
        stderr: 'Error response from daemon: Conflict. The container name is already in use',
      },
    })
    if (role === 'agent') expect((await driver.run(spec)).ok).toBe(false)
    else
      expect(
        await driver.probe('http://host.docker.internal:1234/probe').then(() => 'ok', String),
      ).toContain('Conflict')
    await driver.stop()
    expect(fake.started.filter(({ args }) => args[0] === 'rm')).toHaveLength(0)
    expect(fake.isolation.networks.size).toBe(0)
  },
)

test('a relay create ended by signal stays uncertain until a later sweep can settle and remove its late resources', async () => {
  const fake = new FakeCli()
  fake.responses.push({ match: /^ps /, result: {} })
  const late = Promise.withResolvers<void>()
  let interrupted = false
  const cli: Cli = {
    start(args) {
      if (!interrupted && args[0] === 'create' && args.includes('kurumi.role=relay')) {
        interrupted = true
        const proc = new FakeProcess()
        proc.complete({ code: 143 })
        setTimeout(() => {
          fake.start(args)
          late.resolve()
        }, 10)
        return proc
      }
      return fake.start(args)
    },
  }
  const driver = createDockerDriver({ install: 'late-relay', image, agentPort: 1234, cli })
  expect(await driver.run(spec)).toMatchObject({
    ok: false,
    reason: expect.stringContaining('cleanup unconfirmed'),
  })
  expect(fake.started.some(({ args }) => args[0] === 'create')).toBe(false)
  await late.promise
  expect(await driver.kill(spec.containerId, 0).then(() => 'ok', String)).toContain('unconfirmed')
  await driver.sweep()
  await driver.kill(spec.containerId, 0)
  await driver.stop()
  expect(fake.isolation.networks.size).toBe(0)
  expect([...fake.isolation.containers.keys()]).toEqual([])
})

test('stopping during relay construction waits for settlement and never starts the runner', async () => {
  const fake = new FakeCli()
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const cli: Cli = {
    start(args) {
      if (args[0] === 'create' && args.includes('kurumi.role=relay')) {
        started.resolve()
        const proc = new FakeProcess()
        void released.promise
          .then(() => {
            const result = fake.isolation.respond(args)
            proc.complete(result ?? {})
          })
          .catch(() => {})
        return proc
      }
      return fake.start(args)
    },
  }
  const driver = createDockerDriver({ install: 'cancel-relay', image, agentPort: 1234, cli })
  const pending = driver.run(spec)
  await started.promise
  const stopping = driver.stop()
  released.resolve()
  expect((await pending).ok).toBe(false)
  await stopping
  expect(fake.started.some(({ args }) => args[0] === 'create')).toBe(false)
  expect(fake.isolation.networks.size).toBe(0)
})

test('shutdown joins in-flight adoption inspection and never registers a late wait', async () => {
  const { driver, fake, options, listed } = setup()
  expect(await driver.run(spec)).toEqual({ ok: true })
  await driver.detach()
  const validating = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cli: Cli = {
    start(args) {
      const proc = options.cli.start(args)
      if (args[0] !== 'container' || args[2] !== listed().dockerId) return proc
      validating.resolve()
      return { kill: () => proc.kill(), result: release.promise.then(() => proc.result) }
    },
  }
  const next = createDockerDriver({ ...options, cli })
  const before = fake.started.filter(({ args }) => args[0] === 'wait').length
  const adoption = next.adopt(listed())
  await validating.promise
  let stopped = false
  const stopping = next.detach().then(() => {
    stopped = true
  })
  await Bun.sleep(5)
  expect(stopped).toBe(false)
  release.resolve()
  expect(await adoption).toMatchObject({ ok: false })
  await stopping
  expect(fake.started.filter(({ args }) => args[0] === 'wait')).toHaveLength(before)
  expect(fake.isolation.networks.size).toBe(1)
})
