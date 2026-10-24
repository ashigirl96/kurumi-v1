import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

type Range = [reason: string, network: string, prefix: number]

const ipv4: Range[] = [
  ['unspecified', '0.0.0.0', 8],
  ['loopback', '127.0.0.0', 8],
  ['private', '10.0.0.0', 8],
  ['private', '172.16.0.0', 12],
  ['private', '192.168.0.0', 16],
  ['carrier-grade NAT', '100.64.0.0', 10],
  ['link-local', '169.254.0.0', 16],
  ['multicast', '224.0.0.0', 4],
  ['reserved', '192.0.0.0', 24],
  ['reserved', '240.0.0.0', 4],
]

const ipv6: Range[] = [
  ['unspecified', '::', 128],
  ['loopback', '::1', 128],
  ['private', '64:ff9b:1::', 48],
  ['link-local', 'fe80::', 10],
  ['site-local', 'fec0::', 10],
  ['unique local', 'fc00::', 7],
  ['multicast', 'ff00::', 8],
  ['reserved', '::', 96],
  ['reserved', '100::', 64],
]

function embeddings([reason, network, prefix]: Range): Range[] {
  const [a = 0, b = 0, c = 0, d = 0] = network.split('.').map(Number)
  const high = ((a << 8) | b).toString(16)
  const low = ((c << 8) | d).toString(16)
  return [
    [reason, `::ffff:0:${high}:${low}`, 96 + prefix],
    [reason, `64:ff9b::${high}:${low}`, 96 + prefix],
    [reason, `2002:${high}:${low}::`, 16 + prefix],
  ]
}

function blockList(ranges: Range[]): BlockList {
  const list = new BlockList()
  for (const [, network, prefix] of ranges) {
    list.addSubnet(network, prefix, isIP(network) === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

const refused = [...ipv4, ...ipv6, ...ipv4.flatMap(embeddings)].map((range) => ({
  reason: range[0],
  list: blockList([range]),
}))

function hostRanges(address: string): Range[] {
  const bare = address.replace(/%.*$/, '')
  const family = isIP(bare)
  if (family === 4) {
    const range: Range = ['host interface', bare, 32]
    return [range, ...embeddings(range)]
  }
  return family === 6 ? [['host interface', bare, 128]] : []
}

export function hostAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries = []) =>
    entries.map(({ address }) => address),
  )
}

export function addressRefusal(address: string, host: readonly string[]): string | null {
  const bare = address.replace(/%.*$/, '')
  const family = isIP(bare)
  if (family === 0) return 'unparseable'
  const type = family === 4 ? 'ipv4' : 'ipv6'
  const reason = refused.find(({ list }) => list.check(bare, type))?.reason
  if (reason) return reason
  return blockList(host.flatMap(hostRanges)).check(bare, type) ? 'host interface' : null
}
