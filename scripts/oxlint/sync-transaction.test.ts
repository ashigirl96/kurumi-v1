import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const probes = {
  'packages/account/src/inline.ts': 'db.transaction(async (tx) => tx)\n',
  'packages/account/src/named.ts':
    'async function write(tx) { return tx }\ndb.transaction(write)\n',
  'packages/account/src/bound.ts': 'const write = async (tx) => tx\ndb.transaction(write)\n',
  'packages/account/src/wrapped.ts':
    'async function write(tx) { return tx }\ndb.transaction((tx) => write(tx))\n',
  'packages/account/src/computed.ts': 'db[transaction](async (tx) => tx)\n',
  'packages/account/src/sync.ts': 'db.transaction((tx) => tx)\n',
}

test('transaction に async 関数を直接渡しても、名前で渡しても、同期の関数から呼んでも止まり、同期の関数は通る', async () => {
  const diagnostics = await lintProbes(probes)

  const flagged = diagnostics
    .filter((d) => d.code.includes('sync-transaction'))
    .map((d) => d.filename)
    .toSorted()
  expect(flagged).toEqual([
    'packages/account/src/bound.ts',
    'packages/account/src/inline.ts',
    'packages/account/src/named.ts',
    'packages/account/src/wrapped.ts',
  ])
}, 30_000)
