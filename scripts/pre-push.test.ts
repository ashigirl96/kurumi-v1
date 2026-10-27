import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, '../.githooks/pre-push')
const zero = '0'.repeat(40)
const old = '1'.repeat(40)
const head = '2'.repeat(40)
const update = `refs/heads/main ${head} refs/heads/main ${old}\n`
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function setup(scanner: 'gitleaks' | 'docker' | 'none' = 'gitleaks') {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-pre-push-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(Bun.which('git')!, join(bin, 'git'))
  expect(Bun.spawnSync(['git', 'init', '-q', dir]).exitCode).toBe(0)
  const log = join(dir, 'scan.log')
  writeFileSync(log, '')
  if (scanner !== 'none') {
    const path = join(bin, scanner)
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = version ]; then
  printf '%s\\n' "$SCAN_VERSION"
  exit 0
fi
printf '%s\\n' "$@" >> "$SCAN_LOG"
while IFS= read -r line; do :; done
exit "$SCAN_EXIT"
`,
    )
    chmodSync(path, 0o755)
  }
  return {
    dir,
    run(input: string, env: Record<string, string> = {}) {
      const result = Bun.spawnSync(['/bin/sh', hook], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: bin,
          SCAN_LOG: log,
          SCAN_VERSION: '8.30.1',
          SCAN_EXIT: '0',
          ...env,
        },
        stdin: Buffer.from(input),
      })
      return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        args: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
      }
    },
  }
}

test('scans every pushed ref with CI options without consuming the remaining stdin', () => {
  const { run } = setup()
  const result = run(update + `refs/heads/topic ${head} refs/heads/topic ${zero}\n`)
  expect(result.exitCode).toBe(0)
  expect(result.args).toEqual([
    'git',
    '--redact',
    '--no-banner',
    `--log-opts=-m ${old}..${head}`,
    'git',
    '--redact',
    '--no-banner',
    `--log-opts=-m ${head} --not --remotes`,
  ])
})

test('deletions and pushes with no updates need no scanner', () => {
  const { run } = setup('none')
  expect(run(`(delete) ${zero} refs/heads/topic ${old}\n`).exitCode).toBe(0)
  expect(run('').exitCode).toBe(0)
})

test('a scanner finding or failure refuses the push', () => {
  const { run } = setup()
  expect(run(update, { SCAN_EXIT: '1' }).exitCode).not.toBe(0)
  expect(run(update, { SCAN_EXIT: '2' }).exitCode).not.toBe(0)
})

test('Docker fallback uses the pinned image and mounts the Git common directory for worktrees', () => {
  const { dir, run } = setup('docker')
  const result = run(update)
  expect(result.exitCode).toBe(0)
  expect(result.args).toEqual([
    'run',
    '--rm',
    '-v',
    `${dir}:${dir}`,
    '-v',
    `${dir}/.git:${dir}/.git`,
    '--workdir',
    dir,
    'zricethezav/gitleaks:v8.30.1',
    'git',
    '--redact',
    '--no-banner',
    `--log-opts=-m ${old}..${head}`,
  ])
})

test('a failed Docker scan refuses the push', () => {
  const { run } = setup('docker')
  expect(run(update, { SCAN_EXIT: '125' }).exitCode).not.toBe(0)
})

test('a missing scanner explains installation and the explicit bypass', () => {
  const { run } = setup('none')
  const result = run(update)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('8.30.1')
  expect(result.stderr).toContain('https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1')
  expect(result.stderr).toContain('Docker')
  expect(result.stderr).toContain('git push --no-verify')
})

test('a different native version refuses the push to keep local scans aligned with CI', () => {
  const { run } = setup()
  const result = run(update, { SCAN_VERSION: '8.29.0' })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('8.30.1')
  expect(result.stderr).toContain('git push --no-verify')
  expect(result.args).toEqual([])
})
