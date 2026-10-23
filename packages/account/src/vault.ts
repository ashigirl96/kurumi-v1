import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 0x01
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES

export class VaultError extends Error {}

function checkKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new VaultError(`the vault key must be ${KEY_BYTES} bytes, not ${key.byteLength}`)
  }
}

/** Layout: `[version 0x01][iv 12][tag 16][ciphertext]`. The account id is the associated data. */
export function seal(key: Uint8Array, accountId: string, plaintext: string): Buffer {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(accountId))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), ciphertext])
}

export function open(key: Uint8Array, accountId: string, sealed: Uint8Array): string {
  checkKey(key)
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  if (bytes.byteLength < HEADER_BYTES) {
    throw new VaultError(`sealed material for ${accountId} is too short`)
  }
  if (bytes[0] !== VERSION) {
    throw new VaultError(`sealed material for ${accountId} has unknown version ${bytes[0]}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + IV_BYTES))
  decipher.setAAD(Buffer.from(accountId))
  decipher.setAuthTag(bytes.subarray(1 + IV_BYTES, HEADER_BYTES))
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(HEADER_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    throw new VaultError(`sealed material for ${accountId} failed authentication`, {
      cause: error,
    })
  }
}
