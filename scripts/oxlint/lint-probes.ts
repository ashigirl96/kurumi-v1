import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = join(import.meta.dir, '../..')

export type Diagnostic = { filename: string; code: string; message: string }

const dirs: string[] = []

// A test cut off by its timeout skips its finally, so the caller's test file removes the directories in afterAll.
export function cleanUpLintProbes() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function lintProbes(
  files: Record<string, string>,
  links: Record<string, string> = {},
): Promise<Diagnostic[]> {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-lint-probes-'))
  dirs.push(dir)
  copyFileSync(join(repo, '.oxlintrc.json'), join(dir, '.oxlintrc.json'))
  mkdirSync(join(dir, 'scripts/oxlint'), { recursive: true })
  copyFileSync(join(repo, 'scripts/oxlint/kurumi.js'), join(dir, 'scripts/oxlint/kurumi.js'))
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    symlinkSync(target, join(dir, path))
  }
  const roots = [...new Set(Object.keys(files).map((path) => path.split('/')[0]!))]
  const oxlint = Bun.spawn([process.execPath, 'run', '--bun', 'oxlint', '-f', 'json', ...roots], {
    cwd: dir,
    env: { ...process.env, PATH: '' },
    stdout: 'pipe',
  })
  const report = (await new Response(oxlint.stdout).json()) as { diagnostics: Diagnostic[] }
  await oxlint.exited
  return report.diagnostics
}
