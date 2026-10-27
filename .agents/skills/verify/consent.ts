import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { catalog } from '../../../packages/account/src/catalog.ts'

const services = {
  gmail: /gmail|Gmail|メール/,
  'google-calendar': /calendar|Calendar|カレンダー/,
}

export function consentUrl(raw: string, webPort: number, depth = 0): URL {
  if (depth > 8) throw new Error('too many nested authorize URLs')
  const url = new URL(raw)
  const google =
    url.origin === 'https://accounts.google.com' &&
    (/^\/o\/oauth2\/(?:v2\/)?auth(?:\/(?:oauthchooseaccount|identifier))?$/.test(url.pathname) ||
      /^\/(?:v3\/signin|signin)\/oauth\//.test(url.pathname) ||
      url.pathname === '/v3/signin/accountchooser' ||
      url.pathname === '/AccountChooser')
  const connect =
    url.origin === `http://127.0.0.1:${webPort}` && /^\/connect\/[^/]+$/.test(url.pathname)
  if (url.username || url.password || (!google && !connect)) {
    throw new Error(
      "consent URL must be a Google authorize URL or this lane's loopback /connect/<token> link",
    )
  }
  if (url.searchParams.getAll('redirect_uri').length > 1) {
    throw new Error('duplicate redirect_uri is forbidden')
  }
  for (const nested of url.searchParams.getAll('continue')) consentUrl(nested, webPort, depth + 1)
  const redirect = url.searchParams.get('redirect_uri')
  if (redirect) {
    const callback = new URL(redirect)
    if (
      callback.protocol !== 'http:' ||
      callback.hostname !== '127.0.0.1' ||
      callback.pathname !== '/oauth/callback' ||
      callback.username ||
      callback.password
    ) {
      throw new Error('Google redirect_uri must be a loopback /oauth/callback URL')
    }
  }
  return url
}

export function authorizationUrl(url: URL): URL {
  const nested = url.searchParams.get('continue')
  return nested ? authorizationUrl(new URL(nested)) : url
}

export function requireRequestedService(url: URL, service: keyof typeof services): void {
  const requested = new Set(authorizationUrl(url).searchParams.get('scope')?.split(/\s+/))
  if (!catalog.google.services[service].scopes.every((scope) => requested.has(scope))) {
    throw new Error(`--uncheck ${service}: authorize URL does not request that service`)
  }
}

type MaskRoot = { children: Iterable<MaskElement> }
type MaskElement = MaskRoot & {
  textContent: string | null
  tagName: string
  value?: unknown
  getAttribute: (name: string) => string | null
  shadowRoot: MaskRoot | null
  style?: { filter: string }
}

export function maskScreenshot(root: MaskRoot): void {
  const sensitive = (text: string) => /[^\s@]+@[^\s@]+|https?:\/\//i.test(text)
  for (const element of root.children) {
    const children = Array.from(element.children)
    const text = element.textContent ?? ''
    const attributes = ['placeholder', 'title', 'aria-label'].map(
      (name) => element.getAttribute(name) ?? '',
    )
    if (
      element.tagName === 'IFRAME' ||
      sensitive(
        `${typeof element.value === 'string' ? element.value : ''} ${attributes.join(' ')}`,
      ) ||
      (sensitive(text) && !children.some((child) => sensitive(child.textContent ?? '')))
    ) {
      if (element.style && element.style.filter !== 'blur(16px)')
        element.style.filter = 'blur(16px)'
    }
    maskScreenshot(element)
    if (element.shadowRoot) maskScreenshot(element.shadowRoot)
  }
}

export function browserProfile(listing: string, name: string | undefined): string[] {
  if (!name)
    throw new Error('set KURUMI_VERIFY_BROWSER_PROFILE to the signed-in profile display name')
  const directory = listing
    .split('\n')
    .map((line) => /^  (.+?)  \((.*)\)$/.exec(line))
    .find((match) => match?.[2] === name)?.[1]
  if (!directory)
    throw new Error('KURUMI_VERIFY_BROWSER_PROFILE was not found by agent-browser profiles')
  return [
    '--profile',
    directory,
    ...(listing.split('\n')[0]?.includes('/BraveSoftware/')
      ? ['--executable-path', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
      : []),
  ]
}

export function accountAddress(raw: string, index: string): string {
  const accounts = raw.split(',').map((address) => address.trim())
  const n = Number(index)
  const address = accounts[n - 1]
  if (
    !Number.isSafeInteger(n) ||
    n < 1 ||
    !address ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
  ) {
    throw new Error(
      '--account must select an address in KURUMI_VERIFY_GOOGLE_ACCOUNTS (default: 1)',
    )
  }
  return address
}

function redact(text: string): string {
  return text.replace(/[^\s<>"'()]+@[^\s<>"'()]+/g, '<account>').replace(/https?:\/\/\S+/g, '<url>')
}

export function controls(snapshot: string) {
  return [
    ...snapshot.matchAll(/- (button|link|checkbox) "([^"\n]*)" \[([^\n]*ref=(e\d+)[^\n]*)\]/g),
  ].map(([, role = '', name = '', state = '', ref = '']) => ({
    role,
    name,
    ref: `@${ref}`,
    checked: /\bchecked(?:=true)?\b/.test(state) && !/checked=false/.test(state),
  }))
}

async function drive(argv: string[]): Promise<void> {
  const usage = 'usage: consent.ts <lane> <url> [--account <n>] [--uncheck <service>] [--cancel]'
  const lane = argv[0]
  if (!lane || !/^\d+$/.test(lane)) throw new Error(usage)
  const evidence = `/tmp/kurumi-verify/lane-${lane}/evidence`
  await mkdir(evidence, { recursive: true })
  const session = `kurumi-verify-${lane}`
  let interrupted = false
  let cleaningUp = false
  let activeChild: ReturnType<typeof Bun.spawn> | undefined
  const interrupt = () => {
    interrupted = true
    activeChild?.kill()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const browser = async (args: string[], input?: string): Promise<string> => {
    if (interrupted && !cleaningUp) throw new Error('consent interrupted by signal')
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: '10000' },
    })
    activeChild = child
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    activeChild = undefined
    if (interrupted && !cleaningUp) throw new Error('consent interrupted by signal')
    if (code !== 0) throw new Error(`agent-browser ${args[0]} failed: ${redact(stderr || stdout)}`)
    return stdout.trim()
  }
  const run = Date.now()
  let shot = 0
  const mask = `(${maskScreenshot.toString()})(document)`
  const screenshot = async (stage: string) => {
    await browser(['eval', '--stdin'], mask)
    const path = join(evidence, `consent-${run}-${String(++shot).padStart(2, '0')}-${stage}.png`)
    await browser(['screenshot', path])
    console.log(`screenshot: ${path}`)
  }
  const desktopUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  let opened = false
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string', default: '1' },
        uncheck: { type: 'string' },
        cancel: { type: 'boolean', default: false },
      },
    })
    const [parsedLane, raw] = positionals
    if (positionals.length !== 2 || parsedLane !== lane || !raw) throw new Error(usage)
    const webPort = 41001 + 10 * Number(lane)
    if (webPort > 65535) throw new Error('lane web port exceeds 65535')
    const url = consentUrl(raw, webPort)
    const address = accountAddress(process.env.KURUMI_VERIFY_GOOGLE_ACCOUNTS ?? '', values.account)
    const omitted = values.uncheck
    if (omitted !== undefined && omitted !== 'gmail' && omitted !== 'google-calendar') {
      throw new Error('--uncheck must be gmail or google-calendar')
    }
    if (!process.env.KURUMI_VERIFY_BROWSER_PROFILE) browserProfile('', undefined)
    const profile = browserProfile(
      await browser(['profiles']),
      process.env.KURUMI_VERIFY_BROWSER_PROFILE,
    )
    const initial = authorizationUrl(url)
    if (omitted && initial.searchParams.has('scope')) requireRequestedService(initial, omitted)
    const init = join(evidence, `mask-${run}.js`)
    await writeFile(
      init,
      `const mask = () => { ${mask} }; const frame = () => { mask(); requestAnimationFrame(frame) }; frame();`,
    )
    await browser(['close'])
    // agent-browser exits its daemon 100 ms after acknowledging close.
    await Bun.sleep(250)
    opened = true
    await browser([
      ...profile,
      '--args',
      '--disable-extensions',
      '--init-script',
      init,
      '--user-agent',
      desktopUserAgent,
      'open',
      url.href,
    ])
    const deadline = Date.now() + 120_000
    let selected = false
    let authorization = initial
    while (Date.now() < deadline) {
      const current = new URL(await browser(['get', 'url']))
      if (current.hostname === '127.0.0.1' && current.pathname === '/oauth/callback') {
        const redirect = authorization.searchParams.get('redirect_uri')
        if (
          redirect
            ? current.origin + current.pathname !==
              new URL(redirect).origin + new URL(redirect).pathname
            : current.origin !== `http://127.0.0.1:${webPort}`
        ) {
          throw new Error('callback does not belong to the consent request')
        }
        await screenshot('callback')
        console.log(redact(await browser(['get', 'text', 'body'])))
        const error = current.searchParams.get('error')
        if (error) throw new Error(`Google consent failed: ${error}`)
        if (values.cancel) throw new Error('Google consent was not cancelled')
        return
      }
      if (current.origin !== 'https://accounts.google.com') {
        await screenshot('refused')
        throw new Error('consent left Google without reaching the loopback callback')
      }
      const requested = authorizationUrl(consentUrl(current.href, webPort))
      if (requested.searchParams.has('scope')) {
        authorization = requested
        if (omitted) requireRequestedService(authorization, omitted)
      }
      const snapshot = await browser(['snapshot', '-i'])
      const items = controls(snapshot)
      const chooser = /アカウントを選択|Choose an account/i.test(snapshot)
      let action: (typeof items)[number] | undefined
      if (chooser) {
        action = items.find((item) => item.name.split(/\s+/).includes(address))
        if (!action)
          throw new Error('selected test account is absent from the Google account chooser')
        selected = true
      } else {
        if (!selected) {
          throw new Error(
            'Google skipped the account chooser; refusing to consent to an unselected account',
          )
        }
        action = items.find((item) => /安全ではないページ|Go to .*\(unsafe\)/i.test(item.name))
        if (!action && /確認されていません|hasn.t verified/i.test(snapshot)) {
          action = items.filter((item) => /^(詳細|Advanced)$/.test(item.name)).at(-1)
        }
        action ??= items.find((item) =>
          /^(閉じる|後で|今はしない|保存しない|Close|Not now|No thanks|Never)$/.test(item.name),
        )
        if (!action && values.cancel) {
          action = items.find((item) => /^(キャンセル|拒否|Cancel|Deny)$/.test(item.name))
        }
        if (!action) {
          const checkboxes = items.filter((item) => item.role === 'checkbox')
          const permissionPage = /アクセスを求め|アクセスをリクエスト|access to|can access/i.test(
            snapshot,
          )
          if (
            omitted &&
            permissionPage &&
            !checkboxes.some((item) => services[omitted].test(item.name))
          ) {
            requireRequestedService(authorization, omitted)
            throw new Error(`account already granted ${omitted}; use an account without that grant`)
          }
          const target = checkboxes.find((item) => {
            const service = Object.entries(services).find(([, pattern]) =>
              pattern.test(item.name),
            )?.[0]
            return service !== undefined && item.checked !== (service !== omitted)
          })
          if (target) {
            await browser(['scrollintoview', target.ref])
            await browser(['scroll', 'down', '300'])
            await screenshot('checkbox')
            await browser([target.checked ? 'uncheck' : 'check', target.ref])
            continue
          }
          if (checkboxes.length > 0) await screenshot('scopes')
          action = items.find((item) => /^(次へ|続行|許可|Continue|Next|Allow)$/.test(item.name))
        }
      }
      if (action) {
        if (chooser) {
          await browser(
            ['eval', '--stdin'],
            `Array.from(document.querySelectorAll('[data-identifier]')).find(e => e.getAttribute('data-identifier') === ${JSON.stringify(address)})?.scrollIntoView({block: 'center'})`,
          )
        }
        await screenshot(chooser ? 'account' : 'consent')
        if ((await browser(['get', 'url'])) !== current.href) continue
        try {
          await browser(['click', action.ref])
        } catch (error) {
          if ((await browser(['get', 'url'])) === current.href) throw error
        }
        await Bun.sleep(500)
      } else {
        await Bun.sleep(250)
      }
    }
    await screenshot('timeout')
    throw new Error('Google consent timed out after 120s; inspect the masked screenshots')
  } catch (error) {
    cleaningUp = true
    try {
      if (!opened) {
        await browser(['close'])
        await Bun.sleep(250)
        await browser(['--args', '--disable-extensions', 'open', 'about:blank'])
      }
      await screenshot('failure')
    } catch (captureError) {
      console.error(`failure screenshot unavailable: ${redact(String(captureError))}`)
    }
    throw error
  } finally {
    cleaningUp = true
    await browser(['close'])
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

if (import.meta.main) {
  try {
    await drive(process.argv.slice(2))
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}
