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

const noAccounts = { count: 0, sealedWith: () => true }

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
  const key = loadVaultKey(home, noAccounts)

  expect(key.byteLength).toBe(32)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path).equals(key)).toBe(true)
  expect(readdirSync(home)).toEqual(['vault.key'])
})

test('the key is created at 0600 even under a permissive umask', () => {
  const umask = process.umask(0o000)
  try {
    loadVaultKey(home, noAccounts)
  } finally {
    process.umask(umask)
  }

  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('a restart reuses the same key and leaves the file unchanged', () => {
  const first = loadVaultKey(home, noAccounts)
  const before = statSync(path)

  const second = loadVaultKey(home, noAccounts)

  expect(second.equals(first)).toBe(true)
  expect(readFileSync(path).equals(first)).toBe(true)
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  expect(statSync(path).ino).toBe(before.ino)
})

test('a key other users can read is refused with the file, its mode and the fix', () => {
  loadVaultKey(home, noAccounts)
  chmodSync(path, 0o644)

  expect(() => loadVaultKey(home, noAccounts)).toThrow(
    `${path} has mode 0644, so other users can read it. Run: chmod 600 ${path}`,
  )
})

test('a key of the wrong length is refused', () => {
  writeFileSync(path, Buffer.alloc(31), { mode: 0o600 })

  expect(() => loadVaultKey(home, noAccounts)).toThrow(`${path} is 31 bytes, not 32`)
})

test('a symbolic link in place of the key is refused', () => {
  const target = join(home, 'elsewhere')
  writeFileSync(target, Buffer.alloc(32), { mode: 0o600 })
  symlinkSync(target, path)

  expect(() => loadVaultKey(home, noAccounts)).toThrow(`${path} is a symbolic link`)
})

test('a missing key while accounts are stored is refused with both recoveries and no new key is written', () => {
  const db = join(home, 'kurumi.db')

  expect(() => loadVaultKey(home, { count: 2, sealedWith: () => false })).toThrow(
    `${path} is missing, but ${db} holds 2 accounts sealed with it, and a new key could not open them, so none is created. Restore vault.key from your backup and start the host again. With no backup the stored keys are lost: to start over, keep the host stopped, run sqlite3 ${db} 'PRAGMA foreign_keys = ON; DELETE FROM account;' (or delete kurumi.db with its -wal and -shm files to reset all host state), start the host, and add the keys again.`,
  )
  expect(readdirSync(home)).toEqual([])
})

test('a key that did not seal the stored accounts is refused with both recoveries', () => {
  const db = join(home, 'kurumi.db')
  const key = loadVaultKey(home, noAccounts)
  const tried: Buffer[] = []

  expect(() =>
    loadVaultKey(home, {
      count: 1,
      sealedWith: (candidate) => {
        tried.push(Buffer.from(candidate))
        return false
      },
    }),
  ).toThrow(
    `${path} cannot open the 1 account in ${db}, so it is not the key that sealed it. Put back the vault.key that sealed it from your backup and start the host again. With no backup the stored keys are lost: to start over, keep the host stopped, run sqlite3 ${db} 'PRAGMA foreign_keys = ON; DELETE FROM account;' (or delete kurumi.db with its -wal and -shm files to reset all host state), start the host, and add the keys again.`,
  )
  expect(tried).toEqual([key])
})

test('the key that sealed the stored accounts is loaded', () => {
  const key = loadVaultKey(home, noAccounts)

  expect(
    loadVaultKey(home, { count: 1, sealedWith: (candidate) => key.equals(candidate) }),
  ).toEqual(key)
})
