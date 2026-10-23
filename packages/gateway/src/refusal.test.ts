import { expect, test } from 'bun:test'

import { accountHandle } from '@kurumi/account/server'

import { refusalHttp, refusalResponse, type GatewayRefusal } from './refusal.ts'

const main = accountHandle('anthropic', 'main')
const nonAscii = accountHandle('anthropic', '日本')

test.each([
  [{ code: 'account_not_connected', service: 'anthropic-api' }, 404],
  [{ code: 'account_ambiguous', service: 'anthropic-api', granted: [main, nonAscii] }, 409],
  [
    { code: 'account_not_granted', service: 'anthropic-api', named: 'anthropic/x', granted: [] },
    403,
  ],
  [{ code: 'account_needs_reauth', service: 'anthropic-api', handle: main }, 403],
  [{ code: 'duplicate_slot', service: 'anthropic-api', header: 'x-api-key' }, 400],
] satisfies [GatewayRefusal, number][])('%o answers %d', (refusal, status) => {
  expect(refusalResponse(refusal).status).toBe(status)
})

test('the body names the refusal as error, keeps its fields and says what to do next', () => {
  const { body } = refusalResponse({
    code: 'account_ambiguous',
    service: 'anthropic-api',
    granted: [main, nonAscii],
  })

  expect(JSON.parse(body)).toEqual({
    error: 'account_ambiguous',
    service: 'anthropic-api',
    granted: ['anthropic/main', 'anthropic/日本'],
    next: 'name one of anthropic/main, anthropic/日本: put kurumi:<handle> where the token goes, or ask the owner to set a default',
  })
})

test.each([
  [
    { code: 'account_not_connected', service: 'anthropic-api' },
    'no account is granted anthropic-api for this agent group; ask the owner to add one with kurumi account add-key and grant it',
  ],
  [
    { code: 'account_not_granted', service: 'gmail', named: 'google/x', granted: [] },
    'google/x is not granted gmail for this agent group; put kurumi:<handle> for one of none where the token goes',
  ],
  [
    { code: 'account_needs_reauth', service: 'anthropic-api', handle: main },
    'ask the owner to add anthropic/main again',
  ],
  [
    { code: 'duplicate_slot', service: 'anthropic-api', header: 'authorization' },
    'send the authorization header once',
  ],
] satisfies [GatewayRefusal, string][])('%o says next %p', (refusal, next) => {
  expect(JSON.parse(refusalResponse(refusal).body)).toMatchObject({ error: refusal.code, next })
})

test('the headers mark a gateway answer the client must not retry, sized in bytes', () => {
  const { headers, body } = refusalResponse({
    code: 'account_ambiguous',
    service: 'anthropic-api',
    granted: [main, nonAscii],
  })

  expect(headers).toEqual({
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    connection: 'close',
    'x-should-retry': 'false',
    'x-kurumi-gateway': 'account_ambiguous',
  })
  expect(Number(headers['content-length'])).toBeGreaterThan(body.length)
})

test('the raw form is the same response as HTTP/1.1 bytes', () => {
  const refusal: GatewayRefusal = { code: 'account_not_connected', service: 'anthropic-api' }
  const { body } = refusalResponse(refusal)

  const raw = refusalHttp(refusal)

  expect(raw.startsWith('HTTP/1.1 404 Not Found\r\n')).toBe(true)
  expect(raw).toContain('\r\nx-should-retry: false\r\n')
  expect(raw.slice(raw.indexOf('\r\n\r\n') + 4)).toBe(body)
})
