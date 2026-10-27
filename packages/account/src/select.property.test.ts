import { describe, expect, test } from 'bun:test'

import { defaultSelectorShape, type CredentialSlot } from './catalog.ts'
import { decodedOnce } from './select.reference.ts'
import { readSelector, selectAccount, type AccountHandle, type GrantedCandidate } from './select.ts'

const grant = (handle: string, isDefault = false): GrantedCandidate => ({
  accountId: `id-${handle}`,
  handle: handle as AccountHandle,
  isDefault,
  status: 'active',
})
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
const headerOf = (slot: CredentialSlot): string =>
  slot.kind === 'header' ? slot.header : 'authorization'
const request = (headers: Record<string, string>) => ({
  headers: new Headers(headers),
  url: new URL('https://www.googleapis.com/gmail/v1/users/me/messages'),
})

function seededRandom(seed: number) {
  let state = seed
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!
  return { next, pick }
}

const mentions = (text: string) => /kurumi/i.test(text) || /kurumi/i.test(decodedOnce(text) ?? '')

function handleThatTextNames(text: string): string | null {
  const prefix = /^kurumi:/i.exec(text)
  return prefix ? decodedOnce(text.slice(prefix[0].length)) : null
}

describe('whatever a slot holds', () => {
  const fragments = [
    'kurumi:',
    'KURUMI:',
    'sk-ant-kurumi-',
    'YW50aHJvcGljL2E',
    'google/a',
    'google/Acme',
    'notion/b',
    'Acme',
    'Inc.',
    ', ',
    ',',
    ' ',
    '%2C',
    '%20',
    '%3A',
    '%2F',
    '%E0',
    '%',
    'Bearer ',
    'token ',
    'Basic ',
    'placeholder',
    'x:',
    ':',
    '"',
    '*',
    '=',
    'ya29.',
    '%6Burumi:',
    '%6burumi',
    'a3VydW1p',
    '.',
  ]
  const several = [
    'google/a',
    'google/Acme',
    'google/Acme, Inc.',
    'notion/b',
    'anthropic/a',
    'google/kurumi-x',
  ].map((handle, i) => grant(handle, i === 0))
  const single = [grant('google/a')]
  const slots: [string, CredentialSlot, (text: string) => string][] = [
    ['bearer', { kind: 'bearer' }, (text) => `Bearer ${text}`],
    ['basic', { kind: 'basic' }, (text) => basic('x', text)],
    ['header', { kind: 'header', header: 'x-credential' }, (text) => text],
  ]

  function* texts(count: number): Generator<string> {
    const { next, pick } = seededRandom(20260101)
    for (let i = 0; i < count; i++) {
      const length = 1 + Math.floor(next() * 7)
      yield Array.from({ length }, () => pick(fragments)).join('')
    }
  }

  test.each(slots)(
    'the %s slot never names an account the text does not name alone, nor falls back once it mentions the word',
    (_name, slot, place) => {
      let namedCount = 0
      for (const text of texts(4000)) {
        const { selector } = readSelector(
          defaultSelectorShape,
          slot,
          [],
          request({ [headerOf(slot)]: place(text) }),
        )
        for (const candidates of [several, single]) {
          const selection = selectAccount('gmail', candidates, selector)

          if (!mentions(text)) {
            expect(selection).toMatchObject({
              ok: true,
              how: candidates.length === 1 ? 'only' : 'default',
            })
            continue
          }
          if (!selection.ok) continue
          expect(selection.how).toBe('named')
          namedCount++
          expect((decodedOnce(text) ?? text).match(/kurumi/gi)).toHaveLength(1)
          expect<string>(selection.handle).toBe(
            handleThatTextNames(slot.kind === 'basic' ? text : text.trim())!,
          )
        }
      }
      expect(namedCount).toBeGreaterThan(0)
    },
  )
})
