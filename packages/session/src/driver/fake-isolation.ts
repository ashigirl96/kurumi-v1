import { createHash } from 'node:crypto'

import type { CliResult } from './cli.ts'

const values = (args: readonly string[], flag: string) =>
  args.flatMap((arg, i) => (arg === flag ? [args[i + 1] ?? ''] : []))
const pairs = (args: readonly string[], flag: string) =>
  Object.fromEntries(values(args, flag).map((value) => value.split(/=(.*)/s).slice(0, 2)))
const answer = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const id = (name: string) => createHash('sha256').update(name).digest('hex')

function container(args: readonly string[]) {
  const name = values(args, '--name')[0] ?? ''
  const network = values(args, '--network')[0] ?? 'bridge'
  return {
    Id: id(name),
    State: { Running: true },
    Config: {
      Labels: pairs(args, '--label'),
      Image: args[args.indexOf('bun') - 1] ?? '',
      Cmd: args.slice(args.indexOf('bun')),
    },
    HostConfig: {
      CapDrop: args.includes('--cap-drop=ALL') ? ['ALL'] : [],
      SecurityOpt: values(args, '--security-opt'),
      Privileged: false,
      NetworkMode: network,
      ExtraHosts: values(args, '--add-host'),
      PortBindings: {},
      Sysctls: pairs(args, '--sysctl'),
    },
    Mounts: values(args, '--volume'),
    NetworkSettings: {
      Networks: { [network]: { IPAddress: '192.0.2.2', Aliases: [] as string[] } },
    },
  }
}

export class FakeIsolation {
  readonly calls: string[][] = []
  readonly containers = new Map<string, ReturnType<typeof container>>()
  readonly networks = new Map<
    string,
    {
      Id: string
      Name: string
      Driver: string
      Internal: boolean
      EnableIPv6: boolean
      Labels: Record<string, string>
      Options: Record<string, string>
      Containers: Record<string, unknown>
    }
  >()

  respond(args: readonly string[]): CliResult | undefined {
    const [command, action] = args
    const reference = args.at(-1) ?? ''
    const name = [...this.containers].find(([, c]) => c.Id === reference)?.[0] ?? reference
    const relay = name.endsWith('-relay') || values(args, '--name')[0]?.endsWith('-relay')
    if (!(command === 'network' || command === 'container' || relay)) {
      if (command === 'create') {
        const created = container(args)
        this.containers.set(values(args, '--name')[0] ?? '', created)
        const network = this.networks.get(created.HostConfig.NetworkMode)
        if (network) network.Containers[created.Id] = {}
      }
      return undefined
    }
    this.calls.push([...args])
    const missing = () => ({ code: 1, stdout: '', stderr: `No such ${command}: ${reference}` })
    if (command === 'network') {
      if (action === 'create') {
        if (this.networks.has(reference)) return { code: 1, stdout: '', stderr: 'already exists' }
        this.networks.set(reference, {
          Id: id(reference),
          Name: reference,
          Driver: 'bridge',
          Internal: args.includes('--internal'),
          EnableIPv6: false,
          Labels: pairs(args, '--label'),
          Options: pairs(args, '--opt'),
          Containers: {},
        })
        return answer(id(reference))
      }
      if (action === 'connect') {
        const networkName = args.at(-2) ?? ''
        const network = this.networks.get(networkName)
        const target = this.containers.get(reference)
        if (!network || !target) return missing()
        target.NetworkSettings.Networks[networkName] = {
          IPAddress: '198.51.100.2',
          Aliases: values(args, '--alias'),
        }
        network.Containers[target.Id] = {}
        return answer()
      }
      if (action === 'ls') return answer([...this.networks.keys()].join('\n'))
      const network = [...this.networks.values()].find(
        (n) => n.Name === reference || n.Id === reference,
      )
      if (!network) return missing()
      if (action === 'inspect') return answer(JSON.stringify([network]))
      if (action === 'rm') {
        this.networks.delete(network.Name)
        return answer(reference)
      }
    }
    if (command === 'create') {
      const created = container(args)
      this.containers.set(values(args, '--name')[0] ?? '', created)
      return answer(created.Id)
    }
    const target = this.containers.get(name)
    if (!target) return missing()
    if (command === 'container') return answer(JSON.stringify([target]))
    if (command === 'logs') return answer('resolved 203.0.113.1\nlistening 198.51.100.2\n')
    if (command === 'rm') {
      this.containers.delete(name)
      for (const network of this.networks.values()) delete network.Containers[target.Id]
    }
    return answer(reference)
  }

  setId(name: string, dockerId: string) {
    const target = this.containers.get(name)
    if (!target) return
    for (const network of this.networks.values())
      if (target.Id in network.Containers) {
        delete network.Containers[target.Id]
        network.Containers[dockerId] = {}
      }
    target.Id = dockerId
  }
}
