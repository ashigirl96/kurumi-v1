import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const repo = join(import.meta.dir, '../..')

const entryNames = ['schema', 'contract', 'server', 'ui', 'cli', 'testing']

function internalModules(): { domain: string; module: string }[] {
  const found: { domain: string; module: string }[] = []
  for (const manifest of new Bun.Glob('packages/*/package.json').scanSync({ cwd: repo })) {
    const domain = manifest.split('/')[1]!
    const { exports } = JSON.parse(readFileSync(join(repo, manifest), 'utf8')) as {
      exports: Record<string, string>
    }
    const exported = new Set(Object.values(exports).map((target) => basename(target)))
    for (const file of new Bun.Glob('src/*.ts').scanSync({ cwd: join(repo, 'packages', domain) })) {
      const name = basename(file)
      if (name.endsWith('.test.ts') || exported.has(name)) continue
      found.push({ domain, module: name.replace(/\.ts$/, '') })
    }
  }
  return found
}

async function refusedSpecifiers(specifiers: string[]): Promise<Set<string>> {
  const imports = specifiers.map((specifier, i) => `import * as m${i} from '${specifier}'\n`)
  const used = `export const used = [${specifiers.map((_, i) => `m${i}`).join(', ')}]\n`
  const diagnostics = await lintProbes({ 'packages/probe/src/main.ts': imports.join('') + used })
  const refused = new Set<string>()
  for (const { code, message } of diagnostics) {
    const specifier = /^'(.+?)' import is restricted/.exec(message)?.[1]
    if (code === 'eslint(no-restricted-imports)' && specifier) refused.add(specifier)
  }
  return refused
}

test('another package cannot import a module that its package does not export', async () => {
  const internal = internalModules()
  const specifiers = internal.flatMap(({ domain, module }) => [
    `@kurumi/${domain}/${module}`,
    `@kurumi/${domain}/src/${module}.ts`,
  ])

  const refused = await refusedSpecifiers(specifiers)

  expect(internal.length).toBeGreaterThan(0)
  expect(specifiers.filter((specifier) => !refused.has(specifier))).toEqual([])
})

test('another package can still import the entries of a package', async () => {
  const entries = entryNames.map((name) => `@kurumi/account/${name}`)

  const refused = await refusedSpecifiers(entries)

  expect([...refused]).toEqual([])
})
