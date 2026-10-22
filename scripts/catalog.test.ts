import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')

const readManifest = (path: string) => JSON.parse(readFileSync(join(repo, path), 'utf8'))

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

type RootManifest = { workspaces: { packages: string[]; catalog: Record<string, string> } }

test('apps と packages の package.json は、依存の版を root の catalog か workspace から引く', () => {
  const { workspaces } = readManifest('package.json') as RootManifest
  const members = workspaces.packages.flatMap((pattern) => [
    ...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repo }),
  ])
  expect(members.length).toBeGreaterThan(0)

  const offCatalog: string[] = []
  for (const member of members) {
    const manifest = readManifest(member) as Record<string, Record<string, string> | undefined>
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (!version.startsWith('catalog:') && !version.startsWith('workspace:')) {
          offCatalog.push(`${member} ${name} ${version}`)
        }
      }
    }
  }
  expect(offCatalog).toEqual([])
})

test('root の catalog は版を ^ も ~ も付けずに固定する', () => {
  const { workspaces } = readManifest('package.json') as RootManifest

  const ranged = Object.entries(workspaces.catalog).filter(
    ([, version]) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version),
  )

  expect(Object.keys(workspaces.catalog).length).toBeGreaterThan(0)
  expect(ranged).toEqual([])
})
