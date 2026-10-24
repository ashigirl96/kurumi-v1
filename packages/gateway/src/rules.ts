import { ServiceIdSchema } from '@kurumi/account/contract'
import {
  accountHandle,
  isInterceptedHost,
  parseAccountHandle,
  type AccountHandle,
  type AccountLedger,
  type ServiceId,
} from '@kurumi/account/server'
import { transaction, type Db } from '@kurumi/rpc/server'
import { ORPCError } from '@orpc/server'
import { desc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { ruleEffects, type RuleEffect, type RuleInput, type RuleView } from './contract.ts'
import { egressRule } from './schema.ts'

export type RuleId = string & { readonly __brand: 'RuleId' }

export type RuleTarget =
  | { kind: 'account'; handle: AccountHandle }
  | { kind: 'service'; service: ServiceId }

export type PathPattern = { kind: 'exact'; path: string } | { kind: 'prefix'; base: string }

export type EgressRule = {
  id: RuleId
  priority: number
  effect: RuleEffect
  target: RuleTarget
  host: string | null
  method: string | null
  path: PathPattern | null
}

/** Headers-level facts after account selection. `path` is as sent, query included. */
export type RuleRequest = {
  handle: AccountHandle
  service: ServiceId
  host: string
  method: string
  /** Values of X-HTTP-Method-Override, X-HTTP-Method, X-Method-Override, in any order. */
  methodOverrides: readonly string[]
  path: string
}

export type Verdict = { effect: RuleEffect; ruleId: RuleId } | null

export type CanonicalPath = { kind: 'canonical'; path: string } | { kind: 'ambiguous' }

export type RuleStore = {
  /** Evaluation order: the first row that matches wins. */
  list(): RuleView[]
  /** Throws ORPCError BAD_REQUEST with a message that names the fix. The table CHECKs are the backstop. */
  add(input: RuleInput): RuleView
  remove(id: string): { removed: boolean }
  /** The rules whose account handle or service is the request's. */
  read(key: { handle: AccountHandle; service: ServiceId }): EgressRule[]
}

const ambiguous: CanonicalPath = { kind: 'ambiguous' }

const isSeparatorOrControl = (byte: number) =>
  byte < 0x20 || byte === 0x7f || '/\\%;?#'.includes(String.fromCharCode(byte))

/**
 * The path an upstream routes, or ambiguous when two readings are possible: an upstream may decode an escape,
 * resolve a dot segment, or split on a separator that the raw text hides.
 */
export function canonicalPath(raw: string): CanonicalPath {
  const end = raw.search(/[?#]/)
  const path = end === -1 ? raw : raw.slice(0, end)
  if (!path.startsWith('/') || /[\\;]|\/\//.test(path)) return ambiguous
  for (const [, hex] of path.matchAll(/%([0-9A-Fa-f]{2})?/g)) {
    if (hex === undefined || isSeparatorOrControl(Number.parseInt(hex, 16))) return ambiguous
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return ambiguous
  }
  return decoded.split('/').some((segment) => segment === '.' || segment === '..')
    ? ambiguous
    : { kind: 'canonical', path: decoded }
}

const normalizeHost = (host: string) => host.toLowerCase().replace(/\.$/, '')

function foldPath(path: string): string {
  const lower = path.toLowerCase()
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower
}

function pathMatches(effect: RuleEffect, pattern: PathPattern, path: CanonicalPath): boolean {
  if (path.kind === 'ambiguous') return effect === 'approve'
  const fold = effect === 'approve' ? foldPath : (value: string) => value
  const requested = fold(path.path)
  switch (pattern.kind) {
    case 'exact':
      return requested === fold(pattern.path)
    case 'prefix': {
      const base = fold(pattern.base)
      return requested === base || requested.startsWith(`${base}/`)
    }
    default: {
      const unknown: never = pattern
      return unknown
    }
  }
}

function methodMatches(rule: EgressRule, method: string, overrides: readonly string[]): boolean {
  if (rule.method === null) return true
  switch (rule.effect) {
    case 'approve':
      return method === rule.method || overrides.includes(rule.method)
    case 'allow':
      return overrides.length === 0 && method === rule.method
    default: {
      const unknown: never = rule.effect
      return unknown
    }
  }
}

function targets(rule: EgressRule, request: RuleRequest): boolean {
  switch (rule.target.kind) {
    case 'account':
      return rule.target.handle === request.handle
    case 'service':
      return rule.target.service === request.service
    default: {
      const unknown: never = rule.target
      return unknown
    }
  }
}

/** Higher priority first; at equal priority approve before allow; then the older id. */
function outranks(a: EgressRule, b: EgressRule): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  if (a.effect !== b.effect) return a.effect === 'approve'
  return a.id < b.id
}

export function evaluate(rules: readonly EgressRule[], request: RuleRequest): Verdict {
  const path = canonicalPath(request.path)
  const host = normalizeHost(request.host)
  const method = request.method.toUpperCase()
  const overrides = request.methodOverrides.flatMap((value) =>
    value
      .split(',')
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part !== ''),
  )
  let best: EgressRule | undefined
  for (const rule of rules) {
    if (
      targets(rule, request) &&
      (rule.host === null || rule.host === host) &&
      methodMatches(rule, method, overrides) &&
      (rule.path === null || pathMatches(rule.effect, rule.path, path)) &&
      (best === undefined || outranks(rule, best))
    ) {
      best = rule
    }
  }
  return best ? { effect: best.effect, ruleId: best.id } : null
}

const PREFIX_MARK = '/*'

function patternOf(path: string): PathPattern {
  return path.endsWith(PREFIX_MARK)
    ? { kind: 'prefix', base: path.slice(0, -PREFIX_MARK.length) }
    : { kind: 'exact', path }
}

/** A stored pattern is exactly what matching compares, so it must already be canonical. */
function isRulePath(path: string): boolean {
  const literal = path.endsWith(PREFIX_MARK) ? path.slice(0, -1) : path
  if (/[*?#]/.test(literal)) return false
  const canonical = canonicalPath(literal)
  return canonical.kind === 'canonical' && canonical.path === literal
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function refuse(message: string): never {
  throw new ORPCError('BAD_REQUEST', { message })
}

function hostOf(host: string): string {
  if (host.includes('*')) {
    refuse('kurumi matches exact hosts only; add one rule per host, such as www.googleapis.com')
  }
  if (/[:/\s]/.test(host)) refuse('give the host alone, without a scheme, port, or path')
  const normalized = normalizeHost(host)
  if (!isInterceptedHost(normalized)) {
    refuse(`kurumi never reads requests to ${normalized}, so a rule on it never matches`)
  }
  return normalized
}

const isRuleId = (value: string): value is RuleId => value.startsWith('rul-')

const effectSchema = z.enum(ruleEffects)

type RuleRow = typeof egressRule.$inferSelect

function targetOf(row: RuleRow): RuleTarget {
  const parsed = row.accountHandle === null ? null : parseAccountHandle(row.accountHandle)
  if (parsed) return { kind: 'account', handle: accountHandle(parsed.vendor, parsed.label) }
  if (row.service !== null) return { kind: 'service', service: ServiceIdSchema.parse(row.service) }
  throw new Error(`egress rule ${row.id} names no readable target`)
}

function ruleOf(row: RuleRow): EgressRule {
  if (!isRuleId(row.id)) throw new Error(`egress rule ${row.id} has no rule id`)
  return {
    id: row.id,
    priority: row.priority,
    effect: effectSchema.parse(row.effect),
    target: targetOf(row),
    host: row.host,
    method: row.method,
    path: row.path === null ? null : patternOf(row.path),
  }
}

function viewOf(row: RuleRow): RuleView {
  return {
    id: row.id,
    priority: row.priority,
    effect: row.effect,
    account: row.accountHandle,
    service: row.service,
    host: row.host,
    method: row.method,
    path: row.path,
    createdAt: row.createdAt,
  }
}

export function createRuleStore(deps: {
  db: Db
  accounts: Pick<AccountLedger, 'accountIdOf'>
  now?: () => number
}): RuleStore {
  const now = deps.now ?? Date.now
  const matching = deps.db
    .select()
    .from(egressRule)
    .where(
      or(
        eq(egressRule.accountHandle, sql.placeholder('handle')),
        eq(egressRule.service, sql.placeholder('service')),
      ),
    )
    .prepare()
  return {
    list: () =>
      deps.db
        .select()
        .from(egressRule)
        .orderBy(
          desc(egressRule.priority),
          sql`${egressRule.effect} = 'approve' desc`,
          egressRule.id,
        )
        .all()
        .map(viewOf),
    add: (input) =>
      transaction(deps.db, (tx) => {
        if ((input.account === undefined) === (input.service === undefined)) {
          refuse('name exactly one target: --account or --service')
        }
        if (input.account !== undefined && !deps.accounts.accountIdOf(tx, input.account).ok) {
          refuse(`no account ${input.account}; kurumi account list shows the handles`)
        }
        const host = input.host === undefined ? null : hostOf(input.host)
        if (input.method !== undefined && !HTTP_TOKEN.test(input.method)) {
          refuse(`${input.method} is not an HTTP method; give one such as POST`)
        }
        if (input.path !== undefined && !isRulePath(input.path)) {
          refuse(
            'write the path decoded, rooted, without a query, with * only as a final /* segment',
          )
        }
        return viewOf(
          tx
            .insert(egressRule)
            .values({
              id: `rul-${Bun.randomUUIDv7()}`,
              priority: input.priority,
              effect: input.effect,
              accountHandle: input.account ?? null,
              service: input.service ?? null,
              host,
              method: input.method?.toUpperCase() ?? null,
              path: input.path ?? null,
              createdAt: new Date(now()),
            })
            .returning()
            .get(),
        )
      }),
    remove: (id) =>
      transaction(deps.db, (tx) => ({
        removed:
          tx.delete(egressRule).where(eq(egressRule.id, id)).returning({ id: egressRule.id }).all()
            .length > 0,
      })),
    read: ({ handle, service }) => matching.all({ handle, service }).map(ruleOf),
  }
}
