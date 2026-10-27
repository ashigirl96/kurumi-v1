import { describe, expect, test } from 'bun:test'

import { catalog } from '../../../packages/account/src/catalog.ts'
import {
  accountAddress,
  consentUrl,
  controls,
  maskScreenshot,
  browserProfile,
  requireRequestedService,
  authorizationUrl,
} from './consent.ts'

function element(
  textContent = '',
  children: Parameters<typeof maskScreenshot>[0]['children'] = [],
) {
  return { ...leaf(textContent), children }
}
function leaf(textContent = '') {
  return {
    textContent,
    tagName: 'DIV',
    children: [],
    value: '',
    shadowRoot: null,
    getAttribute: (_name: string): string | null => null,
    style: { filter: '' },
  }
}

describe('screenshot masking before capture', () => {
  test.each(['person@example.test', 'https://example.test/callback?code=private'])(
    'blurs text and input values: %s',
    (sensitive) => {
      const text = element(sensitive)
      const input = { ...element(), value: sensitive }
      maskScreenshot({ children: [text, input] })
      expect(text.style.filter).toBe('blur(16px)')
      expect(input.style.filter).toBe('blur(16px)')
    },
  )
  test('keeps a page without addresses readable', () => {
    const text = element('Gmail permission')
    maskScreenshot({ children: [text] })
    expect(text.style.filter).toBe('')
  })
  test('masks an address split across elements at its common parent', () => {
    const text = element('person@example.test', [leaf('person'), leaf('@'), leaf('example.test')])
    const body = element('person@example.test', [text])
    maskScreenshot({ children: [body] })
    expect(text.style.filter).toBe('blur(16px)')
    expect(body.style.filter).toBe('')
  })
  test('walks open shadow roots', () => {
    const text = element('person@example.test')
    const host = { ...element(), shadowRoot: { children: [text] } }
    maskScreenshot({ children: [host] })
    expect(text.style.filter).toBe('blur(16px)')
  })
  test('masks SVG text', () => {
    const svg = { ...element('person@example.test'), tagName: 'text' }
    maskScreenshot({ children: [svg] })
    expect(svg.style.filter).toBe('blur(16px)')
  })
  test('masks input placeholders', () => {
    const input = {
      ...element(),
      getAttribute: (name: string) => (name === 'placeholder' ? 'person@example.test' : null),
    }
    maskScreenshot({ children: [input] })
    expect(input.style.filter).toBe('blur(16px)')
  })
  test('masks inaccessible iframes', () => {
    const frame = { ...element(), tagName: 'IFRAME' }
    maskScreenshot({ children: [frame] })
    expect(frame.style.filter).toBe('blur(16px)')
  })
  test('reapplies after the page replaces the masked content', () => {
    const root = { children: [element('person@example.test')] }
    maskScreenshot(root)
    root.children = [element('replacement@example.test')]
    maskScreenshot(root)
    expect(root.children[0]?.style.filter).toBe('blur(16px)')
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

test('uncheck requires the catalog service scopes in the actual authorize URL', () => {
  const source = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  source.searchParams.set('scope', catalog.google.services.gmail.scopes.join(' '))
  requireRequestedService(source, 'gmail')
  expect(() => requireRequestedService(source, 'google-calendar')).toThrow('does not request')
})

test('checks nested authorize redirects and rejects duplicates', () => {
  const source = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  source.searchParams.set('redirect_uri', 'https://example.test/oauth/callback')
  const chooser = new URL('https://accounts.google.com/v3/signin/accountchooser')
  chooser.searchParams.set('continue', source.href)
  expect(() => consentUrl(chooser.href, 42311)).toThrow('redirect_uri must be a loopback')
  source.searchParams.set('redirect_uri', 'http://127.0.0.1:42311/oauth/callback')
  chooser.searchParams.set('continue', source.href)
  expect(authorizationUrl(consentUrl(chooser.href, 42311)).href).toBe(source.href)
  source.searchParams.append('redirect_uri', 'https://example.test/oauth/callback')
  expect(() => consentUrl(source.href, 42311)).toThrow('duplicate redirect_uri')
  chooser.searchParams.set('continue', source.href)
  expect(() => consentUrl(chooser.href, 42311)).toThrow('duplicate redirect_uri')
})

test('resolves a display name and adds the executable only for Brave profiles', () => {
  const rows = '\n  Default  (personal)\n  Profile 9  (test)'
  expect(
    browserProfile(
      'Chrome profiles (~/Library/Application Support/BraveSoftware/Brave-Browser):' + rows,
      'test',
    ),
  ).toEqual([
    '--profile',
    'Profile 9',
    '--executable-path',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ])
  expect(browserProfile('Chrome profiles (~/Chrome):' + rows, 'test')).toEqual([
    '--profile',
    'Profile 9',
  ])
  expect(() => browserProfile('', undefined)).toThrow('KURUMI_VERIFY_BROWSER_PROFILE')
  expect(() => browserProfile(rows, 'missing')).toThrow('not found')
})
