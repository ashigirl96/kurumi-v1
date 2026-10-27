import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

async function driverFixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'consent-test-'))
  const executable = join(directory, 'agent-browser')
  const trace = join(directory, 'calls.jsonl')
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[2] === 'eval') args.push(await Bun.stdin.text())
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n')
const command = args[2]
const stateFile = ${JSON.stringify(join(directory, 'state.json'))}
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { step: 0, gmail: false, calendar: true, covered: false }
const mode = ${JSON.stringify(mode)}
if (command === 'profiles') console.log('Chrome profiles (~/Chrome):\\n  Profile 9  (test)')
else if (args.includes('open')) state.url = args.at(-1)
else if (command === 'get' && args[3] === 'url') {
  if (mode.startsWith('submitted') && state.step === 2) state.polls = (state.polls ?? 0) + 1
  console.log(state.step === 2 && (!mode.startsWith('submitted') || state.polls > 6) ? (mode.startsWith('submitted-') ? 'chrome-error://chromewebdata/' : 'http://127.0.0.1:42411/oauth/callback') : state.url)
}
else if (command === 'eval' && args.at(-1).includes("getEntriesByType('navigation')")) console.log(JSON.stringify(mode === 'submitted-wrong-callback' ? 'http://127.0.0.1:42421/oauth/callback' : 'http://127.0.0.1:42411/oauth/callback'))
else if (command === 'get') console.log('Consent completed')
else if (command === 'snapshot') {
  if (mode === 'signal') await new Promise(() => setInterval(() => {}, 1000))
  console.log(state.step === 0
    ? '- heading "Choose an account"\\n- link "second@example.test" [ref=e1]'
    : '- heading "kurumi wants access to your account"\\n' + ((mode === 'hidden' || mode.startsWith('submitted')) ? '' : '- checkbox "Read Gmail" [checked=' + state.gmail + ', ref=e2]\\n- checkbox "Read Calendar" [checked=' + state.calendar + ', ref=e3]\\n') + '- button "Continue" [ref=e4]')
} else if (['click', 'check', 'uncheck'].includes(command)) {
  if ((mode === args[3] && !state.covered) || (mode.startsWith('submitted') && state.step === 2)) {
    state.covered = true
    writeFileSync(stateFile, JSON.stringify(state))
    console.error("Element '" + args[3] + "' is covered by <div.r7fnGb>")
    process.exit(1)
  }
  if (args[3] === '@e1') state.step = 1
  if (args[3] === '@e2') state.gmail = true
  if (args[3] === '@e3') state.calendar = false
  if (args[3] === '@e4') state.step = 2
}
writeFileSync(stateFile, JSON.stringify(state))
`,
  )
  await chmod(executable, 0o755)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set(
    'scope',
    Object.values(catalog.google.services)
      .flatMap((s) => s.scopes)
      .join(' '),
  )
  url.searchParams.set('redirect_uri', 'http://127.0.0.1:42411/oauth/callback')
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'consent.ts'),
      '141',
      url.href,
      '--account',
      '2',
      ...(mode.startsWith('submitted') ? [] : ['--uncheck', 'google-calendar']),
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        KURUMI_VERIFY_BROWSER_PROFILE: 'test',
        KURUMI_VERIFY_GOOGLE_ACCOUNTS: 'first@example.test,second@example.test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const output = new Response(child.stdout).text()
  const error = new Response(child.stderr).text()
  const calls = async (): Promise<string[][]> =>
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return {
    child,
    output,
    error,
    calls,
    url: url.href,
    async cleanup() {
      if (child.exitCode === null) child.kill()
      await child.exited
      for (const args of await calls()) {
        const init = args[args.indexOf('--init-script') + 1]
        if (args.includes('--init-script') && init) await rm(init, { force: true })
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('hidden scope checkboxes refuse without submitting or rewriting the request', async () => {
  const fixture = await driverFixture('hidden')
  try {
    expect(await fixture.child.exited).toBe(1)
    expect(await fixture.error).toContain('account already granted google-calendar')
    const calls = await fixture.calls()
    expect(calls.filter((args) => args.includes('open')).map((args) => args.at(-1))).toEqual([
      fixture.url,
    ])
    expect(calls.some((args) => args[2] === 'click' && args[3] === '@e4')).toBe(false)
    expect(calls.at(-1)?.slice(2)).toEqual(['close'])
  } finally {
    await fixture.cleanup()
  }
})

test.each(['@e1', '@e2', '@e3', '@e4'])(
  'centres every target and retries a covered %s',
  async (ref) => {
    const fixture = await driverFixture(ref)
    try {
      expect(await fixture.child.exited).toBe(0)
      expect(await fixture.error).toBe('')
      const output = await fixture.output
      expect(output).toContain('scope checkbox: gmail=checked')
      expect(output).toContain('scope checkbox: google-calendar=unchecked')
      const calls = await fixture.calls()
      const open = calls.find((args) => args.includes('open'))
      expect(open?.slice(2, 6)).toEqual([
        '--profile',
        'Profile 9',
        '--args',
        '--disable-extensions',
      ])
      expect(
        calls.filter(
          (args) => ['click', 'check', 'uncheck'].includes(args[2] ?? '') && args[3] === ref,
        ),
      ).toHaveLength(2)
      expect(calls.some((args) => args.slice(2).join(' ') === 'scroll down 300')).toBe(true)
      expect(calls.filter((args) => args[2] === 'focus').map((args) => args[3])).toEqual([
        '@e1',
        '@e2',
        '@e3',
        '@e4',
      ])
      expect(
        calls.filter(
          (args) => args[2] === 'eval' && args.at(-1)?.includes("scrollIntoView({block: 'center'"),
        ),
      ).toHaveLength(4)
      expect(calls.at(-1)?.slice(2)).toEqual(['close'])
    } finally {
      await fixture.cleanup()
    }
  },
)

test('SIGTERM interrupts a browser command and closes the session', async () => {
  const fixture = await driverFixture('signal')
  try {
    const deadline = Date.now() + 5000
    let waiting = false
    while (!waiting && Date.now() < deadline) {
      waiting = (await fixture.calls().catch(() => [])).some((args) => args[2] === 'snapshot')
      if (!waiting) await Bun.sleep(20)
    }
    expect(waiting).toBe(true)
    fixture.child.kill('SIGTERM')
    expect(await fixture.child.exited).toBe(1)
    expect(await fixture.error).toContain('consent interrupted by signal')
    expect((await fixture.calls()).at(-1)?.slice(2)).toEqual(['close'])
  } finally {
    await fixture.cleanup()
  }
})

test.each(['submitted', 'submitted-no-listener'])(
  'waits after short re-consent until the redirect without re-clicking: %s',
  async (mode) => {
    const fixture = await driverFixture(mode)
    try {
      expect(await fixture.child.exited).toBe(0)
      expect(await fixture.error).toBe('')
      const output = await fixture.output
      expect(output).toContain('-callback.png')
      expect(output).not.toContain('covered click')
      const calls = await fixture.calls()
      expect(calls.filter((args) => args[2] === 'click' && args[3] === '@e4')).toHaveLength(1)
      expect(calls.at(-1)?.slice(2)).toEqual(['close'])
    } finally {
      await fixture.cleanup()
    }
  },
  10_000,
)

test('rejects a failed callback navigation belonging to a different consent request', async () => {
  const fixture = await driverFixture('submitted-wrong-callback')
  try {
    expect(await fixture.child.exited).toBe(1)
    expect(await fixture.error).toContain('callback does not belong to the consent request')
    expect((await fixture.calls()).at(-1)?.slice(2)).toEqual(['close'])
  } finally {
    await fixture.cleanup()
  }
}, 10_000)
