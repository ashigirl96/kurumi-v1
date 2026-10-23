import { BlockList, isIP } from 'node:net'

const refusedRanges: [reason: string, network: string, prefix: number][] = [
  ['unspecified', '0.0.0.0', 8],
  ['unspecified', '::', 128],
  ['loopback', '127.0.0.0', 8],
  ['loopback', '::1', 128],
  ['private', '10.0.0.0', 8],
  ['private', '172.16.0.0', 12],
  ['private', '192.168.0.0', 16],
  ['carrier-grade NAT', '100.64.0.0', 10],
  ['link-local', '169.254.0.0', 16],
  ['link-local', 'fe80::', 10],
  ['unique local', 'fc00::', 7],
  ['multicast', '224.0.0.0', 4],
  ['multicast', 'ff00::', 8],
  ['reserved', '240.0.0.0', 4],
  ['reserved', '::', 96],
]

const refused = refusedRanges.map(([reason, network, prefix]) => {
  const list = new BlockList()
  list.addSubnet(network, prefix, isIP(network) === 4 ? 'ipv4' : 'ipv6')
  return { reason, list }
})

export function addressRefusal(address: string): string | null {
  const bare = address.replace(/%.*$/, '')
  const family = isIP(bare)
  if (family === 0) return 'unparseable'
  const type = family === 4 ? 'ipv4' : 'ipv6'
  return refused.find(({ list }) => list.check(bare, type))?.reason ?? null
}
