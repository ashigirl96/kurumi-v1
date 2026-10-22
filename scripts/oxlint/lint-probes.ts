import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = join(import.meta.dir, '../..')

export type Diagnostic = { filename: string; code: string; message: string }

const dirs: string[] = []

// timeout で打ち切られた test は finally を飛ばすので、呼び手の test file が afterAll で消す。
export function cleanUpLintProbes() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

// 設定を読まずに oxlint を当てるので、override の書き方を変えても呼び手のテストは直さずに済む。
export async function lintProbes(files: Record<string, string>): Promise<Diagnostic[]> {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-lint-probes-'))
  dirs.push(dir)
  copyFileSync(join(repo, '.oxlintrc.json'), join(dir, '.oxlintrc.json'))
  symlinkSync(join(repo, 'scripts'), join(dir, 'scripts'))
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
  const roots = [...new Set(Object.keys(files).map((path) => path.split('/')[0]!))]
  const oxlint = Bun.spawn([join(repo, 'node_modules/.bin/oxlint'), '-f', 'json', ...roots], {
    cwd: dir,
    env: process.env,
    stdout: 'pipe',
  })
  const report = (await new Response(oxlint.stdout).json()) as { diagnostics: Diagnostic[] }
  await oxlint.exited
  return report.diagnostics
}
