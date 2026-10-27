import { expect, test } from 'bun:test'

import { addressRefusal, hostAddresses } from './address.ts'

test.each([
  ['127.0.0.1', 'loopback'],
  ['127.255.0.9', 'loopback'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['10.1.2.3', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['192.168.65.254', 'private'],
  ['::ffff:192.168.1.1', 'private'],
  ['100.64.0.1', 'carrier-grade NAT'],
  ['100.127.255.255', 'carrier-grade NAT'],
  ['169.254.169.254', 'link-local'],
  ['fe80::1', 'link-local'],
  ['fe80::1%en0', 'link-local'],
  ['::ffff:169.254.169.254', 'link-local'],
  ['fc00::1', 'unique local'],
  ['fd12:3456::1', 'unique local'],
  ['0.0.0.0', 'unspecified'],
  ['0.1.2.3', 'unspecified'],
  ['::', 'unspecified'],
  ['::ffff:0.0.0.0', 'unspecified'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.250', 'multicast'],
  ['ff02::1', 'multicast'],
  ['255.255.255.255', 'reserved'],
  ['240.0.0.1', 'reserved'],
  ['::127.0.0.1', 'reserved'],
  ['64:ff9b::7f00:1', 'loopback'],
  ['64:ff9b::a9fe:a9fe', 'link-local'],
  ['64:ff9b:1::1', 'private'],
  ['2002:7f00:1::', 'loopback'],
  ['::ffff:0:127.0.0.1', 'loopback'],
  ['2002:a9fe:a9fe::1', 'link-local'],
  ['fec0::1', 'site-local'],
  ['192.0.0.1', 'reserved'],
  ['100::1', 'reserved'],
  ['not-an-address', 'unparseable'],
])('%s is refused as %s', (address, reason) => {
  expect(addressRefusal([])(address)).toBe(reason)
})

test.each([
  '8.8.8.8',
  '93.184.215.14',
  '172.15.255.255',
  '172.32.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '169.253.255.255',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8',
  '64:ff9b::808:808',
  '2002:808:808::1',
  '::ffff:0:808:808',
])('%s is a public address', (address) => {
  expect(addressRefusal([])(address)).toBeNull()
})

const host = [
  '127.0.0.1',
  '203.0.113.7',
  'fe80::1%en0',
  '2001:db8:1::7',
  '2001:db8:2::9%en1',
  '::ffff:198.51.100.9',
]

test.each([
  ['203.0.113.7', 'host interface'],
  ['::ffff:203.0.113.7', 'host interface'],
  ['::ffff:cb00:7107', 'host interface'],
  ['::ffff:0:203.0.113.7', 'host interface'],
  ['64:ff9b::cb00:7107', 'host interface'],
  ['2002:cb00:7107::1', 'host interface'],
  ['2002:cb00:7107:ffff:1:2:3:4', 'host interface'],
  ['2001:db8:1::7', 'host interface'],
  ['2001:0db8:0001:0000:0000:0000:0000:0007', 'host interface'],
  ['2001:DB8:1::7', 'host interface'],
  ['2001:db8:1::7%en0', 'host interface'],
  ['2001:db8:2::9', 'host interface'],
  ['198.51.100.9', 'host interface'],
  ['127.0.0.1', 'loopback'],
  ['fe80::1', 'link-local'],
])('%s on this host is refused as %s', (address, reason) => {
  expect(addressRefusal(host)(address)).toBe(reason)
})

test.each([
  '203.0.113.8',
  '2002:cb00:7108::1',
  '64:ff9b::cb00:7108',
  '2001:db8:1::8',
  '2001:db8:1::7:0',
  '64:ff9b::c633:6409',
  '8.8.8.8',
])('%s, not on this host, is a public address', (address) => {
  expect(addressRefusal(host)(address)).toBeNull()
})

test('the host addresses include the loopback interface', () => {
  expect(hostAddresses()).toContain('127.0.0.1')
})
