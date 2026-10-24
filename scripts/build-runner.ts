import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const home = resolve(process.env.KURUMI_HOME ?? join(homedir(), '.kurumi'))
const outdir = join(home, 'runner')
await mkdir(outdir, { recursive: true, mode: 0o700 })
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, '../apps/runner/src/main.ts')],
  outdir,
  naming: 'runner.js',
  target: 'bun',
  // container/Dockerfile installs the SDK with the native Claude Code binary it spawns.
  external: ['@anthropic-ai/claude-agent-sdk'],
})
if (!result.success) throw new AggregateError(result.logs, 'Runner build failed')
process.stdout.write(`${join(outdir, 'runner.js')}\n`)
