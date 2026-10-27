import { describe, expect, test } from 'bun:test'

import { accountAddress, consentUrl, controls, maskScreenshot, omitService } from './consent.ts'

describe('screenshot masking before capture', () => {
  test('blurs an address in visible text', () => {
    const element = {
      text: 'Selected person@example.test',
      value: '',
      frame: false,
      style: { filter: '' },
    }
    maskScreenshot([element])
    expect(element.style.filter).toBe('blur(16px)')
  })

  test('blurs an address in an input value', () => {
    const input = { text: '', value: 'person@example.test', frame: false, style: { filter: '' } }
    maskScreenshot([input])
    expect(input.style.filter).toBe('blur(16px)')
  })

  test('leaves a page without addresses readable', () => {
    const element = { text: 'Gmail permission', value: '', frame: false, style: { filter: '' } }
    maskScreenshot([element])
    expect(element.style.filter).toBe('')
  })

  test('blurs an iframe whose contents cannot be inspected', () => {
    const frame = { text: '', value: '', frame: true, style: { filter: '' } }
    maskScreenshot([frame])
    expect(frame.style.filter).toBe('blur(16px)')
  })

  test('blurs a URL field containing an OAuth callback', () => {
    const input = {
      text: '',
      value: 'http://127.0.0.1:42311/oauth/callback?code=private',
      frame: false,
      style: { filter: '' },
    }
    maskScreenshot([input])
    expect(input.style.filter).toBe('blur(16px)')
  })
})

describe('consent URL boundary', () => {
  test.each([
    'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail',
    'https://accounts.google.com/o/oauth2/auth',
    'https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount',
    'https://accounts.google.com/v3/signin/accountchooser',
    'https://accounts.google.com/signin/oauth/v3/consent',
    'http://127.0.0.1:42311/connect/one-time-token',
  ])('accepts %s', (url) => {
    expect(consentUrl(url, 42311).href).toBe(url)
  })

  test.each([
    'https://example.com/oauth/callback',
    'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
    'https://accounts.google.com/logout',
    'https://user@accounts.google.com/o/oauth2/v2/auth',
    'http://127.0.0.1:42321/connect/other-lane',
    'http://127.0.0.1:42311/oauth/callback',
    'http://localhost:42311/connect/token',
  ])('rejects %s', (url) => {
    expect(() => consentUrl(url, 42311)).toThrow('consent URL must be')
  })
})

test('rejects a Google URL that sends the code outside loopback', () => {
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://example.com/oauth/callback'
  expect(() => consentUrl(url, 42311)).toThrow('redirect_uri must be a loopback')
})

test('account number selects a configured address, not a chooser position', () => {
  expect(accountAddress('first@example.test, second@example.test', '2')).toBe('second@example.test')
  for (const index of ['0', '3', '1.5', 'x']) {
    expect(() => accountAddress('first@example.test,second@example.test', index)).toThrow(
      '--account',
    )
  }
  expect(() => accountAddress('', '1')).toThrow('KURUMI_VERIFY_GOOGLE_ACCOUNTS')
})

test('reads Google checkbox state and stable account labels from snapshots', () => {
  expect(
    controls(`- link "second@example.test" [ref=e2]
- checkbox "Read Gmail" [checked=false, ref=e3]
- checkbox "Read Calendar" [checked=true, ref=e4]
- button "Continue" [ref=e5]`),
  ).toEqual([
    { role: 'link', name: 'second@example.test', ref: '@e2', checked: false },
    { role: 'checkbox', name: 'Read Gmail', ref: '@e3', checked: false },
    { role: 'checkbox', name: 'Read Calendar', ref: '@e4', checked: true },
    { role: 'button', name: 'Continue', ref: '@e5', checked: false },
  ])
})

test('partial consent preserves state and PKCE while excluding the omitted service', () => {
  const source = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  source.search = new URLSearchParams({
    client_id: 'test-client',
    redirect_uri: 'http://127.0.0.1:42311/oauth/callback',
    state: 'test-state',
    code_challenge: 'test-challenge',
    scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar openid email',
    include_granted_scopes: 'true',
  }).toString()
  const result = omitService(source, 'google-calendar')
  expect(result.searchParams.get('scope')).toBe('https://mail.google.com/ openid email')
  expect(result.searchParams.get('include_granted_scopes')).toBe('false')
  expect(result.searchParams.get('state')).toBe('test-state')
  expect(result.searchParams.get('code_challenge')).toBe('test-challenge')
  expect(result.searchParams.get('redirect_uri')).toBe(source.searchParams.get('redirect_uri'))
  expect(source.searchParams.get('scope')).toContain('/auth/calendar')
  expect(omitService(source, 'gmail').searchParams.get('scope')).toBe(
    'https://www.googleapis.com/auth/calendar openid email',
  )
  expect(() =>
    omitService(new URL('https://accounts.google.com/signin/oauth/consent'), 'gmail'),
  ).toThrow('cannot safely apply --uncheck')
})
