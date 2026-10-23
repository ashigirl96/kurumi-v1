import { randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const KEY_BYTES = 32

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

function readKey(path: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    if (hasCode(error, 'ELOOP')) {
      throw new Error(`${path} is a symbolic link, not the key file`, { cause: error })
    }
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`)
    if ((stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(4, '0')
      throw new Error(
        `${path} has mode ${mode}, so other users can read it. Run: chmod 600 ${path}`,
      )
    }
    if (stat.size !== KEY_BYTES) {
      throw new Error(`${path} is ${stat.size} bytes, not ${KEY_BYTES}, so it is not a vault key`)
    }
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function createKeyAtomically(home: string, path: string): void {
  const temp = join(home, `vault.key.${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, randomBytes(KEY_BYTES))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temp, path)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
  } finally {
    unlinkSync(temp)
  }
  syncDirectory(home)
}

export function loadVaultKey(home: string, { sealedAccounts }: { sealedAccounts: number }): Buffer {
  const path = join(home, 'vault.key')
  const existing = readKey(path)
  if (existing) return existing
  if (sealedAccounts > 0) {
    const accounts = sealedAccounts === 1 ? '1 sealed account' : `${sealedAccounts} sealed accounts`
    throw new Error(
      `${path} is missing, but kurumi.db holds ${accounts} that only it can open. Restore vault.key from your backup; a new key could not open them, so none is created.`,
    )
  }
  createKeyAtomically(home, path)
  const created = readKey(path)
  if (!created) throw new Error(`${path} vanished right after it was created`)
  return created
}
