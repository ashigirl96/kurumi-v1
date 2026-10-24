import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { open, seal, VaultError } from './vault.ts'

const key = randomBytes(32)
const secret = 'sk-ant-api03-secret'

const flipByte = (sealed: Buffer, index: number) => {
  const copy = Buffer.from(sealed)
  copy[index] = (copy[index] ?? 0) ^ 0x01
  return copy
}

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('vault', () => {
  test('sealed material opens back with the same key and account id', () => {
    const sealed = seal(key, 'acc-1', secret)

    expect(open(key, 'acc-1', sealed)).toBe(secret)
    expect(sealed.includes(Buffer.from(secret))).toBe(false)
  })

  test('sealing twice gives different bytes', () => {
    expect(seal(key, 'acc-1', secret).equals(seal(key, 'acc-1', secret))).toBe(false)
  })

  test.each([
    ['a wrong key', () => open(randomBytes(32), 'acc-1', seal(key, 'acc-1', secret))],
    ['another account id', () => open(key, 'acc-2', seal(key, 'acc-1', secret))],
    ['a tampered tag', () => open(key, 'acc-1', flipByte(seal(key, 'acc-1', secret), 13))],
    ['a tampered ciphertext', () => open(key, 'acc-1', flipByte(seal(key, 'acc-1', secret), 29))],
    ['an unknown version', () => open(key, 'acc-1', flipByte(seal(key, 'acc-1', secret), 0))],
    ['a short buffer', () => open(key, 'acc-1', seal(key, 'acc-1', secret).subarray(0, 20))],
  ])('%s is refused without showing the key or the secret', (_name, attempt) => {
    const error = refusal(attempt)

    expect(error).toBeInstanceOf(VaultError)
    const message = error instanceof Error ? error.message : ''
    expect(message).not.toContain(secret)
    expect(message).not.toContain(key.toString('hex'))
    expect(message).not.toContain(key.toString('base64'))
  })

  test('a key that is not 32 bytes is refused', () => {
    expect(() => seal(randomBytes(16), 'acc-1', secret)).toThrow(VaultError)
    expect(() => open(randomBytes(16), 'acc-1', seal(key, 'acc-1', secret))).toThrow(VaultError)
  })
})
