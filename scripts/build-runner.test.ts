import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')
const sdk = '@anthropic-ai/claude-agent-sdk'

const read = (path: string) => readFileSync(join(repo, path), 'utf8')

test('the agent image installs the Agent SDK from its lockfile at the version the catalog pins', () => {
  const manifest: { workspaces: { catalog: Record<string, string> } } = JSON.parse(
    read('package.json'),
  )
  const pinned = manifest.workspaces.catalog[sdk]
  const image: { dependencies: Record<string, string> } = JSON.parse(read('container/package.json'))
  const dockerfile = read('container/Dockerfile')

  expect(image.dependencies[sdk]).toBe(pinned)
  expect(Bun.JSONC.parse(read('container/bun.lock'))).toMatchObject({
    packages: {
      [sdk]: [`${sdk}@${pinned}`, '', expect.anything(), expect.stringMatching(/^sha512-/)],
    },
  })
  expect(dockerfile).toMatch(/^COPY package\.json bun\.lock \.\/$/m)
  expect(dockerfile).toMatch(/^RUN bun install --frozen-lockfile /m)
})

test('the agent image runs the runner as the unprivileged bun user, never root', () => {
  const users = [...read('container/Dockerfile').matchAll(/^USER (\S+)$/gm)].map((line) => line[1])

  expect(users.at(-1)).toBe('bun')
})

test('runner.js imports the Agent SDK from the image instead of bundling it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kurumi-build-runner-'))
  try {
    const build = Bun.spawnSync(['bun', join(repo, 'scripts/build-runner.ts')], {
      env: { ...process.env, KURUMI_HOME: home },
    })
    expect(build.exitCode).toBe(0)
    const runner = readFileSync(join(home, 'runner/runner.js'), 'utf8')
    expect(runner).toContain(`from "${sdk}"`)
    expect(runner).not.toContain('pathToClaudeCodeExecutable')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
