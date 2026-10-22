import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const probes = {
  'packages/account/src/insert.ts':
    "import { agentGroup } from '@kurumi/agent/schema'\ndb.insert(agentGroup).values({})\n",
  'packages/account/src/delete.ts':
    "import { agentGroup } from '@kurumi/agent/schema'\ndb.delete(agentGroup)\n",
  'packages/account/src/update.ts':
    "import { agentGroup as group } from '@kurumi/agent/schema'\ndb.update(group)\n",
  'packages/account/src/namespace.ts':
    "import * as agent from '@kurumi/agent/schema'\ndb.insert(agent.agentGroup)\n",
  'apps/host/src/host.ts':
    "import { account } from '@kurumi/account/schema'\ndb.insert(account).values({})\n",
  'packages/account/src/read.ts':
    "import { agentGroup } from '@kurumi/agent/schema'\ndb.select().from(agentGroup)\n",
  'packages/account/src/own.ts':
    "import { account } from '@kurumi/account/schema'\ndb.insert(account).values({})\n",
  'packages/account/src/type-only.ts':
    "import type { agentGroup } from '@kurumi/agent/schema'\ndb.insert(agentGroup)\n",
}

test('他の domain の table への書き込みは止まり、読み込みと自分の table への書き込みは通る', async () => {
  const diagnostics = await lintProbes(probes)

  const flagged = diagnostics
    .filter((d) => d.code.includes('cross-domain-write'))
    .map((d) => d.filename)
    .toSorted()
  expect(flagged).toEqual([
    'apps/host/src/host.ts',
    'packages/account/src/delete.ts',
    'packages/account/src/insert.ts',
    'packages/account/src/namespace.ts',
    'packages/account/src/update.ts',
  ])
}, 30_000)
