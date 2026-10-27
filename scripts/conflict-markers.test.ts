import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')

const marker = (char: string) => char.repeat(7)
const markerLine = `^(${marker('<')}|${marker('>')})( |$)|^${marker('=')}$`

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function grep(cwd: string, flags: string[] = [], paths: string[] = []) {
  const run = Bun.spawnSync(['git', 'grep', ...flags, '-nE', markerLine, '--', ...paths], { cwd })
  return { exitCode: run.exitCode, stdout: run.stdout.toString() }
}

test('the marker search finds each line of a conflict and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kurumi-markers-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'conflicted.md'),
    [
      'before',
      `${marker('<')} HEAD`,
      'ours',
      marker('='),
      'theirs',
      `${marker('>')} topic`,
      '='.repeat(8),
      `${marker('<')}x`,
      '',
    ].join('\n'),
  )

  expect(grep(dir, ['--no-index'], ['conflicted.md'])).toEqual({
    exitCode: 0,
    stdout: [
      `conflicted.md:2:${marker('<')} HEAD`,
      `conflicted.md:4:${marker('=')}`,
      `conflicted.md:6:${marker('>')} topic`,
      '',
    ].join('\n'),
  })
})

test('no tracked file holds a conflict marker', () => {
  expect(grep(repo)).toEqual({ exitCode: 1, stdout: '' })
})
