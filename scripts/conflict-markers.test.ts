import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')

// Built from repeat so that this file holds no marker line of its own.
const markerLine = `^(${'<'.repeat(7)}|${'>'.repeat(7)})( |$)|^${'='.repeat(7)}$`

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
      `${'<'.repeat(7)} HEAD`,
      'ours',
      '='.repeat(7),
      'theirs',
      `${'>'.repeat(7)} topic`,
      '='.repeat(8),
      `${'<'.repeat(7)}x`,
      '',
    ].join('\n'),
  )

  expect(grep(dir, ['--no-index'], ['conflicted.md'])).toEqual({
    exitCode: 0,
    stdout: [
      `conflicted.md:2:${'<'.repeat(7)} HEAD`,
      `conflicted.md:4:${'='.repeat(7)}`,
      `conflicted.md:6:${'>'.repeat(7)} topic`,
      '',
    ].join('\n'),
  })
})

test('no tracked file holds a conflict marker', () => {
  expect(grep(repo)).toEqual({ exitCode: 1, stdout: '' })
})
