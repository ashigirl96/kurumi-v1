import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let bin: string
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), 'kurumi-egress-probe-'))
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 })
  await writeFile(
    join(bin, 'curl'),
    `#!/bin/sh
if [ "$1" = --noproxy ]; then
  printf '000 %s' "$REMOTE_IP"
  exit "$DIRECT_EXIT"
fi
printf 'x-kurumi-account: %s\\r\\nstatus=%s\\n' "$ACCOUNT" "$STATUS"
`,
    { mode: 0o755 },
  )
})
afterAll(async () => {
  await rm(bin, { recursive: true, force: true })
})

async function probe({
  direct = 7,
  expected = 'blocked',
  account = 'anthropic/main',
  status = '200',
  host = '192.0.2.2',
  remote = '',
} = {}) {
  const child = Bun.spawn(
    ['sh', join(import.meta.dir, 'egress-probe.sh'), 'agent', host, '43531', expected],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DIRECT_EXIT: String(direct),
      REMOTE_IP: remote,
        ACCOUNT: account,
        STATUS: status,
        CLAUDE_CODE_OAUTH_TOKEN: 'selector-only',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return { code: await child.exited, output: await new Response(child.stdout).text() }
}

test('accepts refused or timed-out direct TCP only with a successful account-injected gateway request', async () => {
  expect((await probe()).code).toBe(0)
  expect((await probe({ direct: 28 })).code).toBe(0)
  expect((await probe({ account: 'anthropic/other' })).code).not.toBe(0)
  expect((await probe({ status: '403' })).code).not.toBe(0)
})

test('rejects open egress and DNS-only failure as evidence of TCP isolation', async () => {
  expect((await probe({ direct: 0 })).code).not.toBe(0)
  expect((await probe({ direct: 6 })).code).not.toBe(0)
  expect((await probe({ direct: 0, expected: 'open' })).code).toBe(0)
  expect((await probe({ direct: 7, expected: 'open' })).code).not.toBe(0)
})

test('rejects a TCP connection that succeeded before TLS timed out', async () => {
  expect((await probe({ direct: 28, remote: '192.0.2.1' })).code).not.toBe(0)
})

test('rejects an invalid numeric host address before probing', async () => {
  expect((await probe({ host: '999.1.1.1' })).code).toBe(2)
  expect((await probe({ host: '192.168' })).code).toBe(2)
})
