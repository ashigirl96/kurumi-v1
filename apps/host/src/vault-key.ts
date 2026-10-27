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

import type { StoredAccounts, StoredConnections } from '@kurumi/account/server'

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

const shellQuoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

function connectionRecovery(db: string, ids: readonly string[]): string {
  const client = ids.includes('oauth-client:google')
  const requests = ids.filter((id) => id !== 'oauth-client:google')
  const remove = [
    'PRAGMA foreign_keys = ON;',
    ...(client ? ["DELETE FROM oauth_client WHERE vendor = 'google';"] : []),
    ...(requests.length
      ? [
          `DELETE FROM connection_request WHERE id IN (${requests.map((id) => `'${id.replaceAll("'", "''")}'`).join(', ')});`,
        ]
      : []),
  ].join(' ')
  return `With the host stopped, run sqlite3 ${shellQuoted(db)} ${shellQuoted(remove)} and start the host.${client ? ' Run kurumi account set-client google again.' : ''}${requests.length ? ' Run kurumi account connect again for the removed requests.' : ''}`
}

export function loadVaultKey(
  home: string,
  accounts: StoredAccounts,
  opensGatewayCa: (vaultKey: Uint8Array) => boolean,
  connections: StoredConnections = { count: 0, ids: [], unopenedBy: () => [] },
): Buffer {
  const path = join(home, 'vault.key')
  const db = join(home, 'kurumi.db')
  const counted = accounts.count === 1 ? '1 account' : `${accounts.count} accounts`
  const them = accounts.count === 1 ? 'it' : 'them'
  const quotedDb = shellQuoted(db)
  const startOver = `With no backup the stored keys are lost: to start over, keep the host stopped, run sqlite3 ${quotedDb} 'PRAGMA foreign_keys = ON; DELETE FROM account;' (or delete kurumi.db with its -wal and -shm files to reset all host state), start the host, and add the keys again.`
  const existing = readKey(path)
  if (existing) {
    const unopened = accounts.unopenedBy(existing)
    const unopenedConnections = connections.unopenedBy(existing)
    if (unopenedConnections.length > 0) {
      const knownKey =
        opensGatewayCa(existing) ||
        unopened.length < accounts.count ||
        unopenedConnections.length < connections.count
      const reason = knownKey
        ? 'opens other stored material, but these rows are damaged or were sealed with another vault.key'
        : 'does not match the key that sealed the saved OAuth client or pending connections'
      throw new Error(
        `${path} ${reason} in ${db}: ${unopenedConnections.join(', ')}. Restore vault.key from backup if these rows were sealed with another key. Otherwise discard only the unreadable rows. ${connectionRecovery(db, unopenedConnections)}`,
      )
    }
    if (accounts.count > 0 && unopened.length === accounts.count) {
      if (opensGatewayCa(existing)) {
        const one = unopened.length === 1
        const rowRef = one ? 'this row' : 'these rows'
        const ids = unopened.map((id) => `'${id.replaceAll("'", "''")}'`).join(', ')
        const remove = shellQuoted(
          `PRAGMA foreign_keys = ON; DELETE FROM account WHERE id IN (${ids});`,
        )
        throw new Error(
          `${path} opens the gateway CA but cannot open ${counted} in ${db}: ${unopened.join(', ')}. If ${rowRef} came from a backup made with another vault.key, put that key back and start the host again. Otherwise ${one ? 'the row is' : 'the rows are'} damaged: with the host stopped, run sqlite3 ${quotedDb} ${remove} and start the host. The command also removes the grants and defaults of ${rowRef}: add ${one ? 'the key' : 'the keys'} again, then set those again with kurumi account grant and kurumi account set-default.`,
        )
      }
      throw new Error(
        `${path} does not match the key that sealed the ${counted} in ${db}, so it cannot open ${them}. Put back the vault.key that sealed ${them} from your backup and start the host again. ${startOver}`,
      )
    }
    return existing
  }
  if (connections.count > 0) {
    throw new Error(
      `${path} is missing, but ${db} holds a saved OAuth client or pending connection, so no new key is created. Restore vault.key from backup. Without a backup, discard only the rows sealed with the missing key. ${connectionRecovery(db, connections.ids)}`,
    )
  }
  if (accounts.count > 0) {
    throw new Error(
      `${path} is missing, but ${db} holds ${counted} sealed with it, and a new key could not open ${them}, so none is created. Restore vault.key from your backup and start the host again. ${startOver}`,
    )
  }
  createKeyAtomically(home, path)
  const created = readKey(path)
  if (!created) throw new Error(`${path} vanished right after it was created`)
  return created
}
