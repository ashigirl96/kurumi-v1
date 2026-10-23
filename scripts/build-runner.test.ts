import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')
const sdk = '@anthropic-ai/claude-agent-sdk'

test('the agent image installs the Agent SDK at the version the catalog pins', () => {
  const manifest: { workspaces: { catalog: Record<string, string> } } = JSON.parse(
    readFileSync(join(repo, 'package.json'), 'utf8'),
  )
  const dockerfile = readFileSync(join(repo, 'container/Dockerfile'), 'utf8')

  expect(dockerfile.match(/^ARG CLAUDE_AGENT_SDK_VERSION=(\S+)$/m)?.[1]).toBe(
    manifest.workspaces.catalog[sdk],
  )
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
