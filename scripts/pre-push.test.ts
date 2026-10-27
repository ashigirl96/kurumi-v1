import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, '../.githooks/pre-push')
const zero = '0'.repeat(40)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function setup(scanner: 'gitleaks' | 'docker' | 'none' = 'gitleaks') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kurumi-pre-push-')))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(Bun.which('git')!, join(bin, 'git'))
  expect(Bun.spawnSync(['git', 'init', '-q', dir]).exitCode).toBe(0)
  const commit = () => {
    expect(
      Bun.spawnSync(
        [
          'git',
          '-c',
          'user.name=Hook Test',
          '-c',
          'user.email=hook-test@example.com',
          'commit',
          '--allow-empty',
          '-qm',
          'clean',
        ],
        { cwd: dir },
      ).exitCode,
    ).toBe(0)
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()
  }
  const old = commit()
  const head = commit()
  const update = `refs/heads/main ${head} refs/heads/main ${old}\n`
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
    old,
    head,
    update,
    run: (input: string, env: Record<string, string> = {}) => {
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
  const { run, head, old, update } = setup()
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
  const { run, old } = setup('none')
  expect(run(`(delete) ${zero} refs/heads/topic ${old}\n`).exitCode).toBe(0)
  expect(run('').exitCode).toBe(0)
})

test('a scanner finding or failure refuses the push', () => {
  const { run, update } = setup()
  expect(run(update, { SCAN_EXIT: '1' }).exitCode).not.toBe(0)
  expect(run(update, { SCAN_EXIT: '2' }).exitCode).not.toBe(0)
})

test('Docker fallback uses the pinned image and mounts the repository and Git common directory', () => {
  const { dir, run, old, head, update } = setup('docker')
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
  const { run, update } = setup('docker')
  expect(run(update, { SCAN_EXIT: '125' }).exitCode).not.toBe(0)
})

test('a missing scanner explains installation and the explicit bypass', () => {
  const { run, update } = setup('none')
  const result = run(update)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('8.30.1')
  expect(result.stderr).toContain('https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1')
  expect(result.stderr).toContain('Docker')
  expect(result.stderr).toContain('git push --no-verify')
})

test('a different native version refuses the push to keep local scans aligned with CI', () => {
  const { run, update } = setup()
  const result = run(update, { SCAN_VERSION: '8.29.0' })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('8.30.1')
  expect(result.stderr).toContain('git push --no-verify')
  expect(result.args).toEqual([])
})

test('an unavailable remote commit blocks the push before invoking the scanner', () => {
  const { run, head } = setup()
  const result = run(`refs/heads/main ${head} refs/heads/main ${'1'.repeat(40)}\n`)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('git fetch')
  expect(result.args).toEqual([])
})
