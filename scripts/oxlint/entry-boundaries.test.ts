import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const repo = join(import.meta.dir, '../..')

const entryNames = ['schema', 'contract', 'server', 'ui', 'cli', 'testing']

function internalModules(root = repo): { domain: string; module: string }[] {
  const found: { domain: string; module: string }[] = []
  for (const manifest of new Bun.Glob('packages/*/package.json').scanSync({ cwd: root })) {
    const domain = manifest.split('/')[1]!
    const { exports } = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as {
      exports?: Record<string, string>
    }
    if (!exports) {
      throw new Error(
        `${manifest} has no "exports" field. Declare it, as {} for a package with no entry yet.`,
      )
    }
    const exported = new Set(Object.values(exports).map((target) => basename(target)))
    for (const file of new Bun.Glob('src/*.ts').scanSync({ cwd: join(root, 'packages', domain) })) {
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

const boundaryCodes = new Set([
  'eslint(no-restricted-imports)',
  'kurumi(no-relative-package-import)',
])

async function refusedFiles(files: Record<string, string>): Promise<Set<string>> {
  const diagnostics = await lintProbes(files)
  return new Set(diagnostics.filter(({ code }) => boundaryCodes.has(code)).map((d) => d.filename))
}

const importing = (imports: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(imports).map(([path, specifier]) => [
      path,
      `import * as m from '${specifier}'\nexport const used = m\n`,
    ]),
  )

describe('a relative import that leaves its package', () => {
  const account = 'account/src/catalog.ts'

  test('is refused from any depth and from any file of the package', async () => {
    const files = importing({
      'packages/probe/src/main.ts': `../../${account}`,
      'packages/probe/src/a/main.ts': `../../../${account}`,
      'packages/probe/src/a/b/main.ts': `../../../../${account}`,
      'packages/probe/src/a/b/c/d/e/main.ts': `../../../../../../../${account}`,
      'packages/probe/main.ts': `../${account}`,
      'packages/probe/drizzle.config.ts': `../${account}`,
      'packages/probe/migrations/main.ts': `../../${account}`,
      'packages/probe/src/to-migrations.ts': '../../account/migrations/index.ts',
      'packages/probe/src/to-manifest.ts': '../../account/package.json',
      'packages/probe/src/to-app.ts': '../../../apps/probe/src/main.ts',
      'apps/probe/src/main.ts': `../../../packages/${account}`,
      'tools/main.ts': `../packages/${account}`,
    })

    const refused = await refusedFiles(files)

    expect(Object.keys(files).filter((path) => !refused.has(path))).toEqual([])
  })

  test('is refused whether it is imported, re-exported or loaded on demand', async () => {
    const specifier = `../../../../account/src/catalog.ts`
    const files = {
      'packages/probe/src/a/b/import.ts': `import '${specifier}'\n`,
      'packages/probe/src/a/b/export.ts': `export * from '${specifier}'\n`,
      'packages/probe/src/a/b/named.ts': `export { catalog } from '${specifier}'\n`,
      'packages/probe/src/a/b/dynamic.ts': `export const load = () => import('${specifier}')\n`,
    }

    const refused = await refusedFiles(files)

    expect(Object.keys(files).filter((path) => !refused.has(path))).toEqual([])
  })

  test('inside the package is still allowed', async () => {
    const files = importing({
      'packages/probe/src/main.ts': './other.ts',
      'packages/probe/src/to-migrations.ts': '../migrations/index.ts',
      'packages/probe/src/a/b/main.ts': '../../other.ts',
      'packages/probe/src/a/b/to-migrations.ts': '../../../migrations/index.ts',
      'packages/probe/src/a/b/to-manifest.ts': '../../../package.json',
      'packages/probe/drizzle.config.ts': './src/schema.ts',
      'tools/main.ts': './other.ts',
    })

    const refused = await refusedFiles(files)

    expect([...refused]).toEqual([])
  })
})

type OxlintConfig = {
  rules: Record<string, unknown>
  overrides?: { files: string[]; rules?: Record<string, unknown> }[]
}

const readConfig = (): OxlintConfig =>
  Bun.JSONC.parse(readFileSync(join(repo, '.oxlintrc.json'), 'utf8')) as OxlintConfig

const restrictedImportsOf = (rules: Record<string, unknown> = {}): unknown[] =>
  Object.entries(rules)
    .filter(([name]) => name.split('/').at(-1) === 'no-restricted-imports')
    .map(([, entry]) => entry)

function restrictionsOf(entry: unknown): unknown[] {
  if (!Array.isArray(entry) || (entry[0] !== 'error' && entry[0] !== 2)) return []
  const options = (entry[1] ?? {}) as { patterns?: unknown[]; paths?: unknown[] }
  return [...(options.patterns ?? []), ...(options.paths ?? [])]
}

function overridesDroppingBoundary(config: OxlintConfig): string[] {
  const boundary = restrictedImportsOf(config.rules).flatMap(restrictionsOf)
  return (config.overrides ?? [])
    .filter(({ rules }) =>
      restrictedImportsOf(rules).some((entry) => {
        const kept = restrictionsOf(entry)
        return boundary.some((restriction) => !kept.some((r) => Bun.deepEquals(r, restriction)))
      }),
    )
    .map(({ files }) => files.join(', '))
}

describe('an override that sets no-restricted-imports', () => {
  const config = readConfig()
  const [boundaryRule] = restrictedImportsOf(config.rules)

  const withOverride = (rules: Record<string, unknown>): OxlintConfig => ({
    rules: config.rules,
    overrides: [{ files: ['packages/other/**'], rules }],
  })

  test('the top-level rule carries the entry boundary', () => {
    expect(restrictionsOf(boundaryRule).length).toBeGreaterThan(0)
  })

  test('repeats the boundary patterns of the top-level rule, which the override replaces for its files', () => {
    expect(overridesDroppingBoundary(config)).toEqual([])
  })

  test.each([
    ['other patterns', ['error', { patterns: [{ group: ['@kurumi/*/server'], message: 'm' }] }]],
    ['no options', ['error']],
    ['turned off', 'off'],
    ['warning only', ['warn', ...(boundaryRule as unknown[]).slice(1)]],
  ])('is noticed when it replaces the boundary with %s', (_name, entry) => {
    expect(overridesDroppingBoundary(withOverride({ 'no-restricted-imports': entry }))).toEqual([
      'packages/other/**',
    ])
  })

  test('is noticed under the plugin-qualified rule name', () => {
    const override = withOverride({ 'eslint/no-restricted-imports': ['error'] })

    expect(overridesDroppingBoundary(override)).toEqual(['packages/other/**'])
  })

  test('may add its own restrictions beside the boundary', () => {
    const [severity, options] = boundaryRule as [string, { patterns: unknown[] }]
    const extra = { group: ['@kurumi/*/cli'], message: 'm' }
    const entry = [severity, { ...options, patterns: [...options.patterns, extra] }]

    expect(overridesDroppingBoundary(withOverride({ 'no-restricted-imports': entry }))).toEqual([])
  })
})

describe('a package that does not declare exports', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  test('is named in the failure instead of crashing the probe', () => {
    const root = mkdtempSync(join(tmpdir(), 'kurumi-exports-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/bare/src'), { recursive: true })
    writeFileSync(join(root, 'packages/bare/package.json'), '{ "name": "@kurumi/bare" }')
    writeFileSync(join(root, 'packages/bare/src/inner.ts'), 'export {}\n')

    expect(() => internalModules(root)).toThrow('packages/bare/package.json')
  })
})
