import { expect, test } from 'bun:test'

import { addressRefusal } from './address.ts'

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
  ['not-an-address', 'unparseable'],
])('%s is refused as %s', (address, reason) => {
  expect(addressRefusal(address)).toBe(reason)
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
])('%s is a public address', (address) => {
  expect(addressRefusal(address)).toBeNull()
})
