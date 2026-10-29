import { createHash } from 'node:crypto'

import { z } from 'zod'

import { outputLimit, type Cli, type CliResult } from './cli.ts'
import { createCreation, type Creation } from './create.ts'
import type { ListedContainer } from './listing.ts'
import { relayProgram } from './relay.ts'

const version = 'agent-port-v1'
const networkName = (owner: string) => `${owner}-net`
const relayName = (owner: string) => `${owner}-relay`
const labels = z.record(z.string(), z.string()).nullish()
const endpoint = z.object({ IPAddress: z.string(), Aliases: z.array(z.string()).nullish() })
const containerSchema = z.object({
  Id: z.string(),
  State: z.object({ Running: z.boolean() }),
  Config: z.object({ Labels: labels, Image: z.string(), Cmd: z.array(z.string()) }),
  HostConfig: z.object({
    CapDrop: z.array(z.string()).nullish(),
    SecurityOpt: z.array(z.string()).nullish(),
    Privileged: z.boolean(),
    NetworkMode: z.string(),
    ExtraHosts: z.array(z.string()).nullish(),
    PortBindings: z.record(z.string(), z.unknown()).nullish(),
    Sysctls: z.record(z.string(), z.string()).nullish(),
  }),
  Mounts: z.array(z.unknown()),
  NetworkSettings: z.object({ Networks: z.record(z.string(), endpoint) }),
})
const networkSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Driver: z.string(),
  Internal: z.boolean(),
  EnableIPv6: z.boolean(),
  Labels: labels,
  Options: z.record(z.string(), z.string()),
  Containers: z.record(z.string(), z.unknown()).nullish(),
})

type Group = { pending: Promise<string>; creates: Creation[] }

export function createIsolation(options: {
  cli: Cli
  install: string
  image: string
  agentPort: number
  timeoutMs: number
}) {
  const { cli, install, image, agentPort, timeoutMs } = options
  const { error, settleCreate } = createCreation(options, timeoutMs)
  const program = relayProgram(agentPort)
  const groups = new Map<string, Group>()
  const hardening = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges']

  async function command(args: string[], group?: Group): Promise<CliResult> {
    const proc = cli.start(args)
    const creation =
      group && (args[0] === 'create' || args[1] === 'create') ? settleCreate(proc) : undefined
    if (creation) group?.creates.push(creation)
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      if (creation) creation.cancel()
      else {
        proc.kill()
        deadline.reject(error(`${args[0]} timed out`))
      }
    }, timeoutMs)
    try {
      const exit = await Promise.race([creation?.result ?? proc.result, deadline.promise])
      if (Buffer.byteLength(exit.stdout) > outputLimit)
        throw error('isolation output exceeds limit')
      return exit
    } finally {
      clearTimeout(timer)
    }
  }

  async function run(args: string[], group?: Group): Promise<string> {
    const exit = await command(args, group)
    if (exit.code !== 0)
      throw error(`isolation ${args.slice(0, 2).join(' ')} failed: ${exit.stderr}`)
    return exit.stdout
  }

  async function inspect(kind: 'container' | 'network', name: string) {
    const exit = await command([kind, 'inspect', name])
    if (exit.code !== 0) {
      if (
        /^(?:Error response from daemon: )?(?:No such (?:container|network|object): [^\r\n]+|network [^\r\n]+ not found)\s*$/i.test(
          exit.stderr,
        )
      )
        return null
      throw error(`isolation inspect failed: ${exit.stderr}`)
    }
    const data: unknown = JSON.parse(exit.stdout)
    if (!Array.isArray(data) || data.length !== 1) throw error('invalid isolation inspection')
    return data[0]
  }

  function owned(value: z.infer<typeof labels>, owner: string, role: string) {
    return (
      value?.['kurumi.install'] === install &&
      value['kurumi.owner'] === owner &&
      value['kurumi.role'] === role
    )
  }

  async function ready(name: string, marker: string): Promise<string> {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      const logs = await run(['logs', name])
      const address = new RegExp(`^${marker} ((?:[0-9]{1,3}\\.){3}[0-9]{1,3})$`, 'm').exec(
        logs,
      )?.[1]
      if (address) return address
      if (performance.now() >= deadline) break
      await Bun.sleep(25)
    }
    throw error(`relay did not become ${marker}`)
  }

  function prepare(owner: string): Promise<string> {
    if (groups.has(owner)) throw error('isolation already exists')
    const group: Group = { pending: Promise.resolve(''), creates: [] }
    groups.set(owner, group)
    group.pending = (async () => {
      const network = networkName(owner)
      const relay = relayName(owner)
      for (const [kind, name] of [
        ['network', network],
        ['container', relay],
      ] as const)
        if (await inspect(kind, name)) throw error(`isolation name already exists: ${name}`)
      const identity = [
        '--label',
        `kurumi.install=${install}`,
        '--label',
        `kurumi.owner=${owner}`,
        '--label',
        `kurumi.isolation=${version}`,
      ]
      await run(
        [
          'network',
          'create',
          '--driver',
          'bridge',
          '--internal',
          '--ipv6=false',
          '--opt',
          'com.docker.network.bridge.gateway_mode_ipv4=isolated',
          ...identity,
          '--label',
          'kurumi.role=isolation',
          network,
        ],
        group,
      )
      await run(
        [
          'create',
          '--name',
          relay,
          ...identity,
          '--label',
          'kurumi.role=relay',
          ...hardening,
          '--sysctl',
          'net.ipv4.ip_forward=0',
          '--sysctl',
          'net.ipv6.conf.all.forwarding=0',
          '--cpus',
          '0.25',
          '--memory',
          '128m',
          '--pids-limit',
          '64',
          '--network',
          'bridge',
          '--pull',
          'never',
          ...(process.platform === 'linux'
            ? ['--add-host', 'host.docker.internal:host-gateway']
            : []),
          image,
          'bun',
          '-e',
          program,
        ],
        group,
      )
      await run(['start', relay])
      await ready(relay, 'resolved')
      await run(['network', 'connect', '--alias', 'host.docker.internal', network, relay])
      await ready(relay, 'listening')
      return network
    })()
    return group.pending
  }

  async function remove(owner: string): Promise<void> {
    const group = groups.get(owner)
    await group?.pending.catch(() => {})
    if (group?.creates.some((create) => create.state === 'unconfirmed'))
      throw error('isolation create cleanup unconfirmed')
    const relay = await inspect('container', relayName(owner))
    if (relay) {
      const parsed = containerSchema.parse(relay)
      if (!owned(parsed.Config.Labels, owner, 'relay')) throw error('foreign relay name collision')
      await run(['rm', '--force', parsed.Id])
    }
    const network = await inspect('network', networkName(owner))
    if (network) {
      const parsed = networkSchema.parse(network)
      if (!owned(parsed.Labels, owner, 'isolation')) throw error('foreign network name collision')
      await run(['network', 'rm', parsed.Id])
    }
    groups.delete(owner)
  }

  async function validate(owner: string, dockerId: string): Promise<void> {
    const runner = containerSchema.parse(await inspect('container', dockerId))
    const relay = containerSchema.parse(await inspect('container', relayName(owner)))
    const network = networkSchema.parse(await inspect('network', networkName(owner)))
    const safe = (container: z.infer<typeof containerSchema>) =>
      !container.HostConfig.Privileged &&
      container.HostConfig.CapDrop?.includes('ALL') &&
      container.HostConfig.SecurityOpt?.some(
        (opt) => opt === 'no-new-privileges' || opt === 'no-new-privileges=true',
      ) &&
      Object.keys(container.HostConfig.PortBindings ?? {}).length === 0
    const peers = Object.keys(network.Containers ?? {}).toSorted()
    if (
      runner.Id !== dockerId ||
      !runner.State.Running ||
      !relay.State.Running ||
      !safe(runner) ||
      !safe(relay) ||
      (runner.HostConfig.ExtraHosts?.length ?? 0) !== 0 ||
      runner.HostConfig.NetworkMode !== network.Name ||
      Object.keys(runner.NetworkSettings.Networks).join() !== network.Name ||
      Object.keys(relay.NetworkSettings.Networks).toSorted().join() !==
        [network.Name, 'bridge'].toSorted().join() ||
      !relay.NetworkSettings.Networks[network.Name]?.Aliases?.includes('host.docker.internal') ||
      !owned(relay.Config.Labels, owner, 'relay') ||
      !owned(network.Labels, owner, 'isolation') ||
      network.Labels?.['kurumi.isolation'] !== version ||
      relay.Config.Labels?.['kurumi.isolation'] !== version ||
      network.Driver !== 'bridge' ||
      !network.Internal ||
      network.EnableIPv6 ||
      network.Options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
      peers.join() !== [runner.Id, relay.Id].toSorted().join() ||
      relay.Mounts.length !== 0 ||
      relay.Config.Image !== image ||
      JSON.stringify(relay.Config.Cmd) !== JSON.stringify(['bun', '-e', program]) ||
      relay.HostConfig.Sysctls?.['net.ipv4.ip_forward'] !== '0' ||
      relay.HostConfig.Sysctls?.['net.ipv6.conf.all.forwarding'] !== '0'
    )
      throw error('unsafe Agent Port isolation topology')
    const logs = await run(['logs', relayName(owner)])
    if (
      !logs
        .split('\n')
        .includes(`listening ${relay.NetworkSettings.Networks[network.Name]?.IPAddress}`)
    )
      throw error('relay is not listening on the private interface')
  }

  async function sweep(listed: ListedContainer[]): Promise<void> {
    const active = new Set(
      listed.filter((c) => c.role === 'agent' || c.role === 'probe').map((c) => c.name),
    )
    const networks = await run([
      'network',
      'ls',
      '--filter',
      `label=kurumi.install=${install}`,
      '--filter',
      'label=kurumi.role=isolation',
      '--format',
      '{{.Name}}',
    ])
    const owners = new Set(
      listed.filter((c) => c.role === 'relay').map((c) => c.name.replace(/-relay$/, '')),
    )
    for (const name of networks.trim().split('\n').filter(Boolean)) {
      const network = networkSchema.parse(await inspect('network', name))
      const owner = network.Labels?.['kurumi.owner']
      if (owner && name === networkName(owner) && owned(network.Labels, owner, 'isolation'))
        owners.add(owner)
    }
    for (const owner of owners) if (!active.has(owner) && !groups.has(owner)) await remove(owner)
  }

  return {
    prepare,
    remove,
    validate,
    sweep,
    revision(workload: string | undefined) {
      return createHash('sha256')
        .update(JSON.stringify([version, program, agentPort, image, workload]))
        .digest('hex')
        .slice(0, 16)
    },
    settleListedCreate(listedAt: number) {
      for (const group of groups.values())
        for (const create of group.creates)
          if (create.state === 'unconfirmed' && (create.endedAt ?? Infinity) <= listedAt)
            create.state = 'settled'
    },
  }
}
