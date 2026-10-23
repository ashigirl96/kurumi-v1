import { afterAll, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { createAccountLedger, isInterceptedHost } from '@kurumi/account/server'
import { inMemoryDb, insertAgentGroup } from '@kurumi/account/testing'

import { credentialInject, type ForwardDeps } from './forward.ts'
import { startAgentPort } from './port.ts'
import { openTestTunnel, sendTestRequest, startFakeUpstream } from './testing.ts'

const ROUNDS = 20
const PER_ROUND = 50

const stops: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop()
})

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

test.skipIf(!process.env.KURUMI_BENCH)(
  'credential injection adds under 1 ms per forwarded request at the median',
  async () => {
    const db = inMemoryDb()
    const ledger = createAccountLedger({ db, vaultKey: randomBytes(32) })
    insertAgentGroup(db, 'g1')
    db.transaction((tx) =>
      ledger.addKey(tx, {
        vendor: 'anthropic',
        label: 'main',
        authMode: 'oauth-token',
        value: 'sk-ant-oat01-bench',
        autoGrant: true,
        addedBy: 'bench',
      }),
    )
    const selector = ledger.containerEnv('g1').CLAUDE_CODE_OAUTH_TOKEN
    const upstream = await startFakeUpstream({ host: 'api.anthropic.com' })
    stops.push(upstream.stop)

    const tunnelFor = async (inject: ForwardDeps<{ agentGroupId: string }>['inject']) => {
      const port = await startAgentPort({
        bind: { host: '127.0.0.1', port: 0 },
        authenticate: (token) => (token === 'bench' ? { agentGroupId: 'g1' } : null),
        intercepts: isInterceptedHost,
        forward: { upstream: upstream.destination, inject },
      })
      stops.push(port.stop)
      const tunnel = await openTestTunnel({
        proxyPort: port.port,
        token: 'bench',
        caPem: port.caPem,
        target: { host: 'api.anthropic.com', port: 443 },
      })
      stops.push(tunnel.close)
      return tunnel
    }
    const identity = await tunnelFor(({ path, headers }) => ({ path, headers }))
    const injected = await tunnelFor(credentialInject(ledger))

    const timings: Record<'identity' | 'injected', number[]> = { identity: [], injected: [] }
    for (let round = 0; round < ROUNDS; round++) {
      for (const side of round % 2 === 0
        ? (['identity', 'injected'] as const)
        : (['injected', 'identity'] as const)) {
        const tunnel = side === 'identity' ? identity : injected
        for (let i = 0; i < PER_ROUND; i++) {
          const started = performance.now()
          const response = await sendTestRequest(tunnel, {
            path: '/v1/models',
            headers: { authorization: `Bearer ${selector}` },
          })
          timings[side].push(performance.now() - started)
          expect(response.status).toBe(200)
        }
      }
    }
    const injectedUpstream = upstream.requests.filter(
      ({ headers }) => headers.authorization === 'Bearer sk-ant-oat01-bench',
    )
    expect(injectedUpstream).toHaveLength(timings.injected.length)
    const result = {
      requestsPerSide: timings.identity.length,
      identityMedianMs: median(timings.identity),
      injectedMedianMs: median(timings.injected),
    }
    console.info(
      JSON.stringify({ ...result, addedMs: result.injectedMedianMs - result.identityMedianMs }),
    )
    expect(result.injectedMedianMs - result.identityMedianMs).toBeLessThan(1)
  },
  120_000,
)
