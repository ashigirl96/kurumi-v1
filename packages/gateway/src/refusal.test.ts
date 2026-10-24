import { expect, test } from 'bun:test'

import { accountHandle } from '@kurumi/account/server'

import { REFUSAL_STATUS, refusalHttp, refusalResponse, type GatewayRefusal } from './refusal.ts'

const main = accountHandle('anthropic', 'main')
const nonAscii = accountHandle('anthropic', '日本')
const googleA = accountHandle('google', 'a')

test.each([
  [{ code: 'account_not_connected', service: 'anthropic-api' }, 403],
  [{ code: 'account_ambiguous', service: 'anthropic-api', granted: [main, nonAscii] }, 409],
  [
    { code: 'account_not_granted', service: 'anthropic-api', named: 'anthropic/x', granted: [] },
    403,
  ],
  [{ code: 'account_needs_reauth', service: 'anthropic-api', handle: main }, 403],
  [{ code: 'duplicate_slot', service: 'anthropic-api', header: 'x-api-key' }, 400],
  [{ code: 'upstream_not_public', host: 'api.anthropic.com', reason: 'loopback' }, 403],
  [{ code: 'selector_unreadable', service: 'anthropic-api', written: 'x', accepted: [] }, 400],
  [
    { code: 'method_not_allowed', service: 'anthropic-api', method: 'TRACE', allowed: ['GET'] },
    405,
  ],
  [{ code: 'port_not_allowed', host: 'api.anthropic.com', port: 8443 }, 403],
  [{ code: 'approval_pending', service: 'anthropic-api', approvalId: 'apr-1' }, 403],
  [{ code: 'approval_denied', service: 'anthropic-api', approvalId: 'apr-1' }, 403],
  [{ code: 'body_too_large', service: 'anthropic-api', limit: 10 }, 413],
  [{ code: 'approval_limit', service: 'anthropic-api', waiting: 'undecided', limit: 32 }, 429],
] satisfies [GatewayRefusal, number][])('%o answers %d', (refusal, status) => {
  expect(refusalResponse(refusal).status).toBe(status)
})

test('no refusal answers 404, which Claude Code replaces with a model error and drops the body', () => {
  expect(Object.values(REFUSAL_STATUS)).not.toContain(404)
})

test('a non-public upstream is named with its host and reason', () => {
  const { body } = refusalResponse({
    code: 'upstream_not_public',
    host: 'api.anthropic.com',
    reason: 'private',
  })

  expect(JSON.parse(body)).toEqual({
    error: 'upstream_not_public',
    host: 'api.anthropic.com',
    reason: 'private',
    next: 'ask the owner to check the DNS answer for api.anthropic.com on the kurumi host; it resolves to a private address, and kurumi forwards only to public addresses',
  })
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
    'google/x is not granted gmail for this agent group, and no account is; ask the owner to add one with kurumi account add-key and grant it',
  ],
  [
    { code: 'account_not_granted', service: 'gmail', named: 'google/x', granted: [googleA] },
    'google/x is not granted gmail for this agent group; put kurumi:<handle> for one of google/a where the token goes',
  ],
  [
    {
      code: 'selector_unreadable',
      service: 'anthropic-api',
      written: 'sk-ant-kurumi-anthropic/second',
      accepted: ['sk-ant-kurumi-YW50aHJvcGljL21haW4', 'kurumi:anthropic/main'],
    },
    'kurumi cannot read the account named where the token goes; put one of sk-ant-kurumi-YW50aHJvcGljL21haW4, kurumi:anthropic/main there',
  ],
  [
    { code: 'selector_unreadable', service: 'anthropic-api', written: 'x', accepted: [] },
    'kurumi cannot read the account named where the token goes, and no account is granted anthropic-api for this agent group; ask the owner to add one with kurumi account add-key and grant it',
  ],
  [
    {
      code: 'method_not_allowed',
      service: 'anthropic-api',
      method: 'TRACE',
      allowed: ['GET', 'POST'],
    },
    'send the request as one of GET, POST; kurumi adds no credential to TRACE',
  ],
  [
    { code: 'port_not_allowed', host: 'api.anthropic.com', port: 8443 },
    'connect to api.anthropic.com on port 443; kurumi serves it on no other port',
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
    'x-should-retry': 'false',
    'x-kurumi-gateway': 'account_ambiguous',
  })
  expect(Number(headers['content-length'])).toBeGreaterThan(body.length)
})

test('a refused method is answered with the methods allowed', () => {
  const { status, headers } = refusalResponse({
    code: 'method_not_allowed',
    service: 'anthropic-api',
    method: 'TRACE',
    allowed: ['GET', 'POST'],
  })

  expect(status).toBe(405)
  expect(headers.allow).toBe('GET, POST')
})

test('the raw form is the same response as HTTP/1.1 bytes', () => {
  const refusal: GatewayRefusal = { code: 'account_not_connected', service: 'anthropic-api' }
  const { body } = refusalResponse(refusal)

  const raw = refusalHttp(refusal)

  expect(raw.startsWith('HTTP/1.1 403 Forbidden\r\n')).toBe(true)
  expect(raw).toContain('\r\nx-should-retry: false\r\n')
  expect(raw).toContain('\r\nconnection: close\r\n')
  expect(raw.slice(raw.indexOf('\r\n\r\n') + 4)).toBe(body)
})
