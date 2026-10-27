import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const importing = {
  'static.ts': "import { value } from '@kurumi/account/server'\nexport { value }\n",
  'side-effect.ts': "import '@kurumi/account'\n",
  'type.ts': "import type { Value } from '@kurumi/account/server'\nexport type { Value }\n",
  'export.ts': "export { value } from '@kurumi/account/server'\n",
  'export-all.ts': "export * from '@kurumi/account/server'\n",
  'export-type.ts': "export type { Value } from '@kurumi/account/server'\n",
  'dynamic.ts': "export const load = () => import('@kurumi/account/server')\n",
  'template.ts': 'export const load = () => import(`@kurumi/account/server`)\n',
  'import-type.ts': "export type Value = import('@kurumi/account/server').Value\n",
  'require.ts': "export const value = require('@kurumi/account/server')\n",
  'import-meta.ts': "export const value = import.meta.require('@kurumi/account/server')\n",
  'equals.ts': "import value = require('@kurumi/account/server')\nexport { value }\n",
  'undeclared.test.ts': "import '@kurumi/account/testing'\n",
}

const sourceFiles = (dir: string) =>
  Object.fromEntries(Object.entries(importing).map(([name, source]) => [`${dir}/${name}`, source]))

test('all workspace import forms, including tests and types, need a declaration in their owner', async () => {
  const files = {
    'package.json': JSON.stringify({ devDependencies: { '@kurumi/account': 'workspace:*' } }),
    'packages/probe/package.json': JSON.stringify({ name: '@kurumi/probe' }),
    ...sourceFiles('packages/probe/src'),
    'apps/probe/src/main.ts': "import '@kurumi/account/server'\n",
    'scripts/declared.ts': "import '@kurumi/account/server'\n",
    'scripts/undeclared.ts': "import '@kurumi/agent/server'\n",
    'docs/design/sketch/packages/probe/src/main.ts': "import '@kurumi/account/server'\n",
  }
  const diagnostics = (await lintProbes(files)).filter(
    (d) => d.code === 'kurumi(workspace-dependencies)',
  )

  expect(diagnostics.map((d) => `${d.filename}: ${d.message}`).toSorted()).toEqual(
    [
      ...Object.keys(importing).map(
        (name) =>
          `packages/probe/src/${name}: packages/probe/package.json must declare @kurumi/account as a dependency`,
      ),
      'apps/probe/src/main.ts: apps/probe/package.json must declare @kurumi/account as a dependency',
      'scripts/undeclared.ts: package.json must declare @kurumi/agent as a dependency',
    ].toSorted(),
  )
})

test('any dependency field satisfies every form and self imports need no declaration', async () => {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const files = Object.assign(
    {
      'packages/self/package.json': JSON.stringify({ name: '@kurumi/account' }),
      ...sourceFiles('packages/self/src'),
      'scripts/strings.ts': 'export const example = "import \'@kurumi/account/server\'"\n',
      'scripts/external.ts': "import 'bun:test'\n",
    },
    ...fields.map((field) => ({
      [`packages/${field}/package.json`]: JSON.stringify({
        name: `@kurumi/${field}`,
        [field]: { '@kurumi/account': 'workspace:*' },
      }),
      ...sourceFiles(`packages/${field}/src`),
    })),
  )

  expect(
    (await lintProbes(files)).filter((d) => d.code === 'kurumi(workspace-dependencies)'),
  ).toEqual([])
})
