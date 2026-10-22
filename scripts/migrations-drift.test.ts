import { afterAll, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const repo = join(import.meta.dir, '..')

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const packagesWithMigrations = [
  ...new Bun.Glob('packages/*/drizzle.config.ts').scanSync({ cwd: repo }),
]
  .map((config) => config.split('/')[1]!)
  .toSorted()

const migrationFiles = (copy: string) =>
  readdirSync(join(copy, 'migrations'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(copy.length + 1))
    .toSorted()

// The copy keeps the package's own migrations, so `generate` writes a new file only when the schema moved on.
async function generateInCopy(name: string, edit?: (copy: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-drift-'))
  dirs.push(root)
  const copy = join(root, 'packages', name)
  cpSync(join(repo, 'packages', name), copy, {
    recursive: true,
    filter: (path) => basename(path) !== 'node_modules',
  })
  const modules = join(repo, 'packages', name, 'node_modules')
  if (existsSync(modules)) symlinkSync(modules, join(copy, 'node_modules'))
  edit?.(copy)

  const before = migrationFiles(copy)
  const generate = Bun.spawn([process.execPath, 'run', 'generate'], {
    cwd: copy,
    env: process.env,
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const exitCode = await generate.exited
  const added = migrationFiles(copy).filter((file) => !before.includes(file))
  return { added, exitCode }
}

test('the packages with a drizzle config are found, so the checks below run', () => {
  expect(packagesWithMigrations).toEqual(expect.arrayContaining(['account', 'agent']))
})

test.each(packagesWithMigrations)(
  '%s: the migrations match the schema, so there is nothing for `bun run generate` to add',
  async (name) => {
    const { added, exitCode } = await generateInCopy(name)

    expect(exitCode).toBe(0)
    expect(added).toEqual([])
  },
  60_000,
)

test('a service added to the catalog without generating is caught', async () => {
  const { added, exitCode } = await generateInCopy('account', (copy) => {
    const catalog = join(copy, 'src/catalog.ts')
    writeFileSync(
      catalog,
      readFileSync(catalog, 'utf8').replace(
        "      'google-calendar': {",
        "      'google-drive': {\n        displayName: 'Google Drive',\n        hosts: [{ host: 'www.googleapis.com', pathPrefix: '/drive/' }],\n        slot: { kind: 'bearer' },\n        scopes: ['https://www.googleapis.com/auth/drive'],\n      },\n      'google-calendar': {",
      ),
    )
  })

  expect(exitCode).toBe(0)
  expect(added.filter((file) => file.endsWith('.sql'))).toHaveLength(1)
}, 60_000)
