import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { accountHandle, createAccountLedger } from '@kurumi/account/server'
import { inMemoryDb, insertAccount } from '@kurumi/account/testing'
import type { Caller } from '@kurumi/rpc/contract'
import { guardRouter, type KurumiContext } from '@kurumi/rpc/server'
import { createRouterClient, ORPCError } from '@orpc/server'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import type { RuleEffect, RuleInput } from './contract.ts'
import {
  canonicalPath,
  createRuleStore,
  evaluate,
  type RuleRequest,
  type RuleStore,
} from './rules.ts'
import { egressRule } from './schema.ts'
import { migrations, router } from './server.ts'

const main = accountHandle('anthropic', 'main')
const second = accountHandle('anthropic', 'second')
const mailbox = accountHandle('google', 'me')

function setup() {
  const db = inMemoryDb()
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  insertAccount(db, {
    id: 'a-main',
    vendor: 'anthropic',
    label: 'main',
    services: ['anthropic-api'],
  })
  insertAccount(db, {
    id: 'a-second',
    vendor: 'anthropic',
    label: 'second',
    services: ['anthropic-api'],
  })
  insertAccount(db, { id: 'a-mail', vendor: 'google', label: 'me', services: ['gmail'] })
  const rules = createRuleStore({
    db,
    accounts: createAccountLedger({ db, vaultKey: randomBytes(32) }),
  })
  const add = (input: Partial<RuleInput>) => rules.add({ priority: 0, effect: 'approve', ...input })
  return { db, rules, add }
}

const anthropic = (overrides: Partial<RuleRequest> = {}): RuleRequest => ({
  handle: main,
  service: 'anthropic-api',
  host: 'api.anthropic.com',
  method: 'POST',
  methodOverrides: [],
  pathAsSent: '/v1/messages',
  ...overrides,
})

const gmail = (overrides: Partial<RuleRequest> = {}): RuleRequest => ({
  handle: mailbox,
  service: 'gmail',
  host: 'gmail.googleapis.com',
  method: 'POST',
  methodOverrides: [],
  pathAsSent: '/gmail/v1/users/me/messages/send',
  ...overrides,
})

const verdictOf = (
  rules: RuleStore,
  request: RuleRequest,
): { effect: RuleEffect; ruleId: string } | null => evaluate(rules.read(request), request)

test('an account rule matches requests made as that account and no other', () => {
  const { rules, add } = setup()
  const rule = add({ account: 'anthropic/main', method: 'POST', path: '/v1/messages' })

  expect(verdictOf(rules, anthropic())).toEqual({ effect: 'approve', ruleId: rule.id })
  expect(verdictOf(rules, anthropic({ handle: second }))).toBeNull()
})

test('a service rule matches every account of that service and no other service', () => {
  const { rules, add } = setup()
  const rule = add({ service: 'anthropic-api', path: '/v1/messages' })

  expect(verdictOf(rules, anthropic())).toEqual({ effect: 'approve', ruleId: rule.id })
  expect(verdictOf(rules, anthropic({ handle: second }))).toEqual({
    effect: 'approve',
    ruleId: rule.id,
  })
  expect(verdictOf(rules, gmail({ pathAsSent: '/v1/messages' }))).toBeNull()
})

describe('priority order', () => {
  test('the higher priority wins whatever its effect', () => {
    const { rules, add } = setup()
    add({ service: 'anthropic-api', path: '/v1/messages/*' })
    const carveOut = add({
      service: 'anthropic-api',
      path: '/v1/messages/count_tokens',
      effect: 'allow',
      priority: 10,
    })

    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/messages/count_tokens' }))).toEqual({
      effect: 'allow',
      ruleId: carveOut.id,
    })
    expect(rules.list().map(({ id }) => id)[0]).toBe(carveOut.id)
  })

  test('at equal priority approve wins over allow, then the older rule', () => {
    const { rules, add } = setup()
    const allow = add({ account: 'anthropic/main', effect: 'allow' })
    const older = add({ service: 'anthropic-api' })
    const newer = add({ account: 'anthropic/main' })

    expect(verdictOf(rules, anthropic())).toEqual({ effect: 'approve', ruleId: older.id })
    expect(rules.list().map(({ id }) => id)).toEqual([older.id, newer.id, allow.id])
  })
})

describe('exact host only', () => {
  test.each(['*.googleapis.com', 'www.*.com', '*'])('a %s host is refused', (host) => {
    const { add } = setup()
    expect(() => add({ service: 'gmail', host })).toThrow(
      'kurumi matches exact hosts only; add one rule per host, such as www.googleapis.com',
    )
  })

  test('a host rule matches that host, case and a trailing dot aside, and no other host', () => {
    const { rules, add } = setup()
    const rule = add({ service: 'gmail', host: 'WWW.GoogleAPIs.com.' })

    expect(rule.host).toBe('www.googleapis.com')
    expect(verdictOf(rules, gmail({ host: 'www.googleapis.com.' }))).toEqual({
      effect: 'approve',
      ruleId: rule.id,
    })
    expect(verdictOf(rules, gmail({ host: 'gmail.googleapis.com' }))).toBeNull()
  })
})

describe('exactly one target', () => {
  const row = {
    id: 'rul-raw',
    priority: 0,
    effect: 'approve' as const,
    createdAt: new Date(0),
  }

  test('the table refuses a row with two targets or none', () => {
    const { db } = setup()
    expect(() =>
      db
        .insert(egressRule)
        .values({ ...row, accountHandle: 'anthropic/main', service: 'anthropic-api' })
        .run(),
    ).toThrow(/CHECK constraint failed: egress_rule_one_target/)
    expect(() => db.insert(egressRule).values(row).run()).toThrow(
      /CHECK constraint failed: egress_rule_one_target/,
    )
  })

  test.each([
    ['two targets', { account: 'anthropic/main', service: 'anthropic-api' as const }],
    ['no target', {}],
  ])('rules add with %s is refused and stores nothing', (_name, input) => {
    const { rules, add } = setup()
    expect(() => add(input)).toThrow('name exactly one target: --account or --service')
    expect(rules.list()).toEqual([])
  })
})

test.each([
  ['/v1/messages', '/v1/messages'],
  ['/v1/messages?beta=true', '/v1/messages'],
  ['/v1/%6Dessages', '/v1/messages'],
  ['/users/me%40example.com', '/users/me@example.com'],
  ['/users/me@example.com', '/users/me@example.com'],
  ['/files/%C3%A9t%C3%A9', '/files/été'],
])('%s is canonical as %s', (raw, path) => {
  expect(canonicalPath(raw)).toEqual({ kind: 'canonical', path })
})

test.each([
  ['a percent-encoded dot segment', '/v1/%2e%2e/messages'],
  ['a half-encoded dot segment', '/v1/.%2E/messages'],
  ['a single dot segment', '/v1/./messages'],
  ['a dot-dot segment', '/v1/models/../messages'],
  ['an encoded slash', '/gmail%2Fv1/users'],
  ['a double-encoded dot segment', '/v1/%252e%252e/messages'],
  ['an encoded backslash', '/v1%5Cmessages'],
  ['a backslash', '/v1\\messages'],
  ['a semicolon', '/v1/messages;jsessionid=1'],
  ['an encoded semicolon', '/v1/messages%3Bx'],
  ['an empty segment', '/v1//messages'],
  ['a leading double slash', '//v1/messages'],
  ['a stray percent', '/v1/100%'],
  ['a short escape', '/v1/%4'],
  ['a non-hex escape', '/v1/%zz'],
  ['an encoded control character', '/v1/%00'],
  ['an escape that is not UTF-8', '/v1/%FF'],
  ['an unrooted path', 'v1/messages'],
  ['a raw fragment mark', '/v1/messages#top'],
  ['a raw fragment mark that hides a dot segment', '/v1/models#/../messages'],
  ['a raw fragment mark after the query', '/v1/models?x#/../messages'],
])('a path with %s is ambiguous', (_name, raw) => {
  expect(canonicalPath(raw)).toEqual({ kind: 'ambiguous' })
})

describe('doubt holds', () => {
  test('an approve rule reads the path loosely: case, a trailing slash, and an ambiguous path match', () => {
    const { rules, add } = setup()
    const rule = add({ account: 'anthropic/main', path: '/v1/messages' })
    const held = { effect: 'approve' as const, ruleId: rule.id }

    expect(verdictOf(rules, anthropic({ pathAsSent: '/V1/Messages/' }))).toEqual(held)
    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/%6Dessages?beta=true' }))).toEqual(held)
    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/models/../messages' }))).toEqual(held)
    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/models#/../messages' }))).toEqual(held)
    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/messages/batches' }))).toBeNull()
  })

  test('an allow rule never matches an ambiguous or differently cased path', () => {
    const { rules, add } = setup()
    const approve = add({ service: 'anthropic-api' })
    const allow = add({
      service: 'anthropic-api',
      path: '/v1/models/*',
      effect: 'allow',
      priority: 10,
    })

    expect(verdictOf(rules, anthropic({ pathAsSent: '/v1/models/claude' }))).toEqual({
      effect: 'allow',
      ruleId: allow.id,
    })
    for (const path of [
      '/v1/models/../messages',
      '/v1/models/%2e%2e/messages',
      '/V1/models/x',
      '/v1/models/claude#x',
    ]) {
      expect(verdictOf(rules, anthropic({ pathAsSent: path }))).toEqual({
        effect: 'approve',
        ruleId: approve.id,
      })
    }
  })

  test('a prefix rule covers its base and everything under it, never a longer segment', () => {
    const { rules, add } = setup()
    const rule = add({ service: 'gmail', path: '/gmail/v1/users/me/messages/*' })

    for (const path of ['/gmail/v1/users/me/messages', '/gmail/v1/users/me/messages/send']) {
      expect(verdictOf(rules, gmail({ pathAsSent: path }))).toEqual({
        effect: 'approve',
        ruleId: rule.id,
      })
    }
    expect(verdictOf(rules, gmail({ pathAsSent: '/gmail/v1/users/me/messagesX' }))).toBeNull()
  })

  test('a method override header reaches an approve rule and keeps an allow rule from matching', () => {
    const { rules, add } = setup()
    const approve = add({ account: 'anthropic/main', method: 'DELETE' })
    const allow = add({ account: 'anthropic/main', method: 'GET', effect: 'allow', priority: 10 })

    expect(verdictOf(rules, anthropic({ method: 'GET' }))).toEqual({
      effect: 'allow',
      ruleId: allow.id,
    })
    expect(verdictOf(rules, anthropic({ method: 'GET', methodOverrides: ['delete'] }))).toEqual({
      effect: 'approve',
      ruleId: approve.id,
    })
    expect(
      verdictOf(rules, anthropic({ method: 'POST', methodOverrides: ['PUT, Delete'] })),
    ).toEqual({ effect: 'approve', ruleId: approve.id })
    expect(verdictOf(rules, anthropic({ method: 'GET', methodOverrides: ['GET'] }))).toBeNull()
  })

  test('a GET approve rule also holds HEAD, and a GET allow rule matches GET alone', () => {
    const { rules, add } = setup()
    const approve = add({ account: 'anthropic/main', method: 'GET', path: '/v1/models/*' })
    const allow = add({
      account: 'anthropic/main',
      method: 'GET',
      path: '/v1/models/claude',
      effect: 'allow',
      priority: 10,
    })
    const held = { effect: 'approve' as const, ruleId: approve.id }

    expect(verdictOf(rules, anthropic({ method: 'HEAD', pathAsSent: '/v1/models' }))).toEqual(held)
    expect(
      verdictOf(
        rules,
        anthropic({ method: 'POST', methodOverrides: ['head'], pathAsSent: '/v1/models' }),
      ),
    ).toEqual(held)
    expect(verdictOf(rules, anthropic({ method: 'GET', pathAsSent: '/v1/models/claude' }))).toEqual(
      {
        effect: 'allow',
        ruleId: allow.id,
      },
    )
    expect(
      verdictOf(rules, anthropic({ method: 'HEAD', pathAsSent: '/v1/models/claude' })),
    ).toEqual(held)
    expect(verdictOf(rules, anthropic({ method: 'OPTIONS', pathAsSent: '/v1/models' }))).toBeNull()
  })
})

const unused = () => {
  throw new Error('not used by the rules commands')
}

const failure = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('expected the call to fail')
    },
    (error: unknown) => {
      if (!(error instanceof ORPCError)) throw error
      return { code: error.code, message: error.message }
    },
  )

function rulesClient(caller: Caller = { kind: 'host' }) {
  const { db, rules } = setup()
  return createRouterClient(
    guardRouter<
      KurumiContext & {
        gateway: { status: () => never; egressLog: { rows: () => never }; rules: RuleStore }
      }
    >().router({ gateway: router }),
    {
      context: {
        db,
        caller,
        guard: () => ({ kind: 'allow' }),
        grant: null,
        gateway: { status: unused, egressLog: { rows: unused }, rules },
      },
    },
  ).gateway.rules
}

describe('the rules commands', () => {
  test.each([
    [
      'two targets',
      { account: 'anthropic/main', service: 'gmail' as const },
      'name exactly one target: --account or --service',
    ],
    ['no target', {}, 'name exactly one target: --account or --service'],
    [
      'an unknown handle',
      { account: 'anthropic/nobody' },
      'no account anthropic/nobody; kurumi account list shows the handles',
    ],
    [
      'a wildcard host',
      { service: 'gmail' as const, host: '*.googleapis.com' },
      'kurumi matches exact hosts only; add one rule per host, such as www.googleapis.com',
    ],
    [
      'a URL for a host',
      { service: 'gmail' as const, host: 'https://www.googleapis.com' },
      'give the host alone, without a scheme, port, or path',
    ],
    [
      'a host with a port',
      { service: 'gmail' as const, host: 'www.googleapis.com:443' },
      'give the host alone, without a scheme, port, or path',
    ],
    [
      'a host kurumi never reads',
      { service: 'gmail' as const, host: 'example.com' },
      'kurumi never reads requests to example.com, so a rule on it never matches',
    ],
    [
      'a method that is not a token',
      { service: 'gmail' as const, method: 'PO ST' },
      'PO ST is not an HTTP method; give one such as POST',
    ],
    ...['/v1/../messages', '/v1/*/x', '/v1/msg*', 'v1/messages', '/v1/messages?x=1', '/me%40x'].map(
      (path) =>
        [
          `the path ${path}`,
          { service: 'gmail' as const, path },
          'write the path decoded, rooted, without a query, with * only as a final /* segment',
        ] as const,
    ),
  ])('rules add with %s is a BAD_REQUEST naming the fix', async (_name, input, message) => {
    expect(await failure(rulesClient().add(input))).toEqual({ code: 'BAD_REQUEST', message })
  })

  test('rules add, list, and remove round-trip a rule, and remove is idempotent', async () => {
    const rules = rulesClient()
    const added = await rules.add({
      account: 'anthropic/main',
      method: 'post',
      path: '/v1/messages',
    })

    expect(added).toEqual({
      id: expect.stringMatching(/^rul-/),
      priority: 0,
      effect: 'approve',
      account: 'anthropic/main',
      service: null,
      host: null,
      method: 'POST',
      path: '/v1/messages',
      createdAt: expect.any(Date),
    })
    expect(await rules.list()).toEqual([added])
    expect(await rules.remove([added.id])).toEqual({ removed: true })
    expect(await rules.remove([added.id])).toEqual({ removed: false })
    expect(await rules.list()).toEqual([])
  })

  test('an agent may not add a rule', async () => {
    const agent = rulesClient({ kind: 'agent', agentGroupId: 'g1', sessionId: 's1' })
    expect(await failure(agent.add({ service: 'anthropic-api', effect: 'allow' }))).toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
