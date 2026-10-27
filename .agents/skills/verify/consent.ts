import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const services = {
  gmail: /gmail|Gmail|メール/,
  'google-calendar': /calendar|Calendar|カレンダー/,
}

export function consentUrl(raw: string, webPort: number): URL {
  const url = new URL(raw)
  const google =
    url.origin === 'https://accounts.google.com' &&
    (/^\/o\/oauth2\/(?:v2\/)?auth(?:\/(?:oauthchooseaccount|identifier))?$/.test(url.pathname) ||
      /^\/(?:v3\/signin|signin)\/oauth\//.test(url.pathname) ||
      url.pathname === '/v3/signin/accountchooser')
  const connect =
    url.origin === `http://127.0.0.1:${webPort}` && /^\/connect\/[^/]+$/.test(url.pathname)
  if (url.username || url.password || (!google && !connect)) {
    throw new Error(
      "consent URL must be a Google authorize URL or this lane's loopback /connect/<token> link",
    )
  }
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

export function omitService(url: URL, service: 'gmail' | 'google-calendar'): URL {
  if (!url.searchParams.has('scope') || !url.searchParams.has('redirect_uri')) {
    throw new Error('Google hid the requested scopes; cannot safely apply --uncheck')
  }
  const narrowed = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  narrowed.search = url.search
  const scope =
    service === 'gmail' ? 'https://mail.google.com/' : 'https://www.googleapis.com/auth/calendar'
  narrowed.searchParams.set(
    'scope',
    (url.searchParams.get('scope') ?? '')
      .split(/\s+/)
      .filter((s) => s !== scope)
      .join(' '),
  )
  narrowed.searchParams.set('include_granted_scopes', 'false')
  narrowed.searchParams.set('prompt', 'consent select_account')
  return narrowed
}

export function maskScreenshot(
  elements: Iterable<{ text: string; value: string; frame: boolean; style: { filter: string } }>,
): void {
  for (const element of elements) {
    if (element.frame || /@|https?:\/\//i.test(`${element.text} ${element.value}`)) {
      element.style.filter = 'blur(16px)'
    }
  }
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
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      account: { type: 'string', default: '1' },
      uncheck: { type: 'string' },
      cancel: { type: 'boolean', default: false },
    },
  })
  const [lane, raw] = positionals
  if (positionals.length !== 2 || !lane || !/^\d+$/.test(lane) || !raw) {
    throw new Error(
      'usage: consent.ts <lane> <url> [--account <n>] [--uncheck <service>] [--cancel]',
    )
  }
  const webPort = 41001 + 10 * Number(lane)
  if (webPort > 65535) throw new Error('lane web port exceeds 65535')
  const url = consentUrl(raw, webPort)
  const address = accountAddress(process.env.KURUMI_VERIFY_GOOGLE_ACCOUNTS ?? '', values.account)
  const omitted = values.uncheck
  if (omitted !== undefined && omitted !== 'gmail' && omitted !== 'google-calendar') {
    throw new Error('--uncheck must be gmail or google-calendar')
  }
  const evidence = `/tmp/kurumi-verify/lane-${lane}/evidence`
  await mkdir(evidence, { recursive: true })
  const session = `kurumi-verify-${lane}`
  const browser = async (args: string[], input?: string): Promise<string> => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: '10000' },
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`agent-browser ${args[0]} failed: ${redact(stderr || stdout)}`)
    return stdout.trim()
  }
  const run = Date.now()
  let shot = 0
  const screenshot = async (stage: string) => {
    await browser(
      ['eval', '--stdin'],
      `(${maskScreenshot.toString()})(Array.from(document.querySelectorAll('*')).filter(e => e instanceof HTMLElement).map(e => ({
        text: Array.from(e.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''),
        value: typeof e.value === 'string' ? e.value : '',
        frame: e.tagName === 'IFRAME',
        style: e.style
      })))`,
    )
    const path = join(evidence, `consent-${run}-${String(++shot).padStart(2, '0')}-${stage}.png`)
    await browser(['screenshot', path])
    console.log(`screenshot: ${path}`)
  }
  const desktopUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  try {
    await browser([
      '--profile',
      'Profile 2',
      '--executable-path',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '--user-agent',
      desktopUserAgent,
      'open',
      url.href,
    ])
    await browser(['press', 'Escape'])
    const deadline = Date.now() + 120_000
    let selected = false
    let authorization = url
    let narrowed = false
    while (Date.now() < deadline) {
      const current = new URL(await browser(['get', 'url']))
      if (current.hostname === '127.0.0.1' && current.pathname === '/oauth/callback') {
        const redirect = url.searchParams.get('redirect_uri')
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
      if (current.searchParams.has('scope')) authorization = current
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
          const target = checkboxes.find((item) => {
            const service = Object.entries(services).find(([, pattern]) =>
              pattern.test(item.name),
            )?.[0]
            return service !== undefined && item.checked !== (service !== omitted)
          })
          if (target) {
            await browser([target.checked ? 'uncheck' : 'check', target.ref])
            continue
          }
          if (checkboxes.length > 0) await screenshot('scopes')
          action = items.find((item) => /^(次へ|続行|許可|Continue|Next|Allow)$/.test(item.name))
          if (
            action &&
            omitted &&
            !narrowed &&
            /アクセスを求め|アクセスをリクエスト|access to|can access/i.test(snapshot) &&
            !checkboxes.some((item) => services[omitted].test(item.name))
          ) {
            const limited = consentUrl(omitService(authorization, omitted).href, webPort)
            console.log(`Google hid the ${omitted} checkbox; restart with that scope omitted`)
            await browser(['open', limited.href])
            narrowed = true
            selected = false
            continue
          }
        }
      }
      if (action) {
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
  } finally {
    await browser(['close'])
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
