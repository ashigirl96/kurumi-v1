import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadVaultKey } from './vault-key.ts'

let home: string
let path: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kurumi-vault-key-'))
  path = join(home, 'vault.key')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

test('the first start creates a 32-byte key readable only by its owner', () => {
  const key = loadVaultKey(home)

  expect(key.byteLength).toBe(32)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path).equals(key)).toBe(true)
  expect(readdirSync(home)).toEqual(['vault.key'])
})

test('the key is created at 0600 even under a permissive umask', () => {
  const umask = process.umask(0o000)
  try {
    loadVaultKey(home)
  } finally {
    process.umask(umask)
  }

  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('a restart reuses the same key and leaves the file unchanged', () => {
  const first = loadVaultKey(home)
  const before = statSync(path)

  const second = loadVaultKey(home)

  expect(second.equals(first)).toBe(true)
  expect(readFileSync(path).equals(first)).toBe(true)
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  expect(statSync(path).ino).toBe(before.ino)
})

test('a key other users can read is refused with the file, its mode and the fix', () => {
  loadVaultKey(home)
  chmodSync(path, 0o644)

  expect(() => loadVaultKey(home)).toThrow(
    `${path} has mode 0644, so other users can read it. Run: chmod 600 ${path}`,
  )
})

test('a key of the wrong length is refused', () => {
  writeFileSync(path, Buffer.alloc(31), { mode: 0o600 })

  expect(() => loadVaultKey(home)).toThrow(`${path} is 31 bytes, not 32`)
})

test('a symbolic link in place of the key is refused', () => {
  const target = join(home, 'elsewhere')
  writeFileSync(target, Buffer.alloc(32), { mode: 0o600 })
  symlinkSync(target, path)

  expect(() => loadVaultKey(home)).toThrow(`${path} is a symbolic link`)
})
