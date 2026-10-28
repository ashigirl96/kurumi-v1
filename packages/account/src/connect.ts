import { randomBytes } from 'node:crypto'

import { agentGroup } from '@kurumi/agent/schema'
import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db, type Tx } from '@kurumi/rpc/server'
import { ORPCError } from '@orpc/server'
import { and, eq, gt, inArray, lte, ne, notInArray } from 'drizzle-orm'
import { z } from 'zod'

import { catalog, IdentifyError, servicesCovered, vendorOf, type ServiceId } from './catalog.ts'
import { ConnectInputSchema, GoogleClientSchema } from './contract.ts'
import { grant } from './grant.ts'
import { accountMaterial } from './material.ts'
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  OAuthError,
  readCallback,
  s256Challenge,
} from './oauth.ts'
import { account, accountGrant, connectionRequest, connectLink, oauthClient } from './schema.ts'
import { open, seal } from './vault.ts'

type RequestRow = typeof connectionRequest.$inferSelect
type RequestBase = Omit<RequestRow, 'state' | 'oauthState' | 'pkceVerifier' | 'accountId'>
export type ConnectionRequest = RequestBase &
  (
    | { state: 'open'; oauthState: null; pkceVerifier: null; accountId: null }
    | { state: 'authorizing'; oauthState: string; pkceVerifier: Buffer; accountId: null }
    | {
        state: 'completed'
        oauthState: string | null
        pkceVerifier: Buffer | null
        accountId: string | null
      }
    | {
        state: 'expired' | 'cancelled'
        oauthState: string | null
        pkceVerifier: Buffer | null
        accountId: string | null
      }
  )

export function parseConnectionRequest(row: RequestRow): ConnectionRequest {
  const { state, oauthState, pkceVerifier, accountId } = row
  if (state === 'open' && oauthState === null && pkceVerifier === null && accountId === null)
    return { ...row, state, oauthState, pkceVerifier, accountId }
  if (state === 'authorizing' && oauthState !== null && pkceVerifier !== null && accountId === null)
    return { ...row, state, oauthState, pkceVerifier, accountId }
  if (state === 'completed') return { ...row, state }
  if (state === 'expired' || state === 'cancelled') return { ...row, state }
  throw new Error(`invalid connection request state: ${row.id}`)
}

const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand('ConnectToken')
export type ConnectToken = z.infer<typeof tokenSchema>
const hashOf = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex')
const clientAad = 'oauth-client:google'
const linkTtl = 5 * 60_000
const requestTtl = 30 * 60_000

export type ConnectionOptions = {
  webPort?: number
  canApprove?: (caller: Caller, agentGroupId: string) => boolean
  cards?: {
    post(
      tx: Tx,
      sessionId: string,
      card: {
        owner: 'account.connect'
        ref: string
        title: string
        body: string
        buttons: { action: string; label: string }[]
      },
    ): string
    deliver(id: string): Promise<void>
  }
  fetch?: typeof fetch
  log?: (
    event:
      | {
          kind: 'account.refresh'
          accountId: string
          outcome: 'fresh' | 'needs_reauth' | 'transient_failure' | 'superseded'
          durationMs: number
        }
      | { kind: 'account.connect.completed'; requestId: string; transactionMs: number }
      | { kind: 'account.connect.failed'; requestId: string; reason: string },
  ) => void
}

type OpenLink = { kind: 'authorize'; url: URL } | { kind: 'unavailable' }
type CallbackPage =
  | { kind: 'completed'; granted: ServiceId[]; missing: ServiceId[] }
  | { kind: 'cancelled' | 'unavailable' | 'failed' | 'nothing-granted' }

export function googleClient(db: Db, vaultKey: Uint8Array) {
  const row = db.select().from(oauthClient).where(eq(oauthClient.vendor, 'google')).get()
  return row ? GoogleClientSchema.parse(JSON.parse(open(vaultKey, clientAad, row.material))) : null
}

export function createConnections({
  db,
  vaultKey,
  webPort = 4001,
  canApprove = (caller) => caller.kind === 'host',
  cards,
  fetch: fetchImpl = fetch,
  log = () => {},
}: {
  db: Db
  vaultKey: Uint8Array
} & ConnectionOptions) {
  const exchanges = new Map<string, ReturnType<typeof exchangeCode>>()
  const attempts = new Map<string, number>()
  const redirectUri = `http://127.0.0.1:${webPort}/oauth/callback`
  const clientOf = () => {
    const client = googleClient(db, vaultKey)
    if (!client)
      throw new ORPCError('BAD_REQUEST', { message: 'run account set-client google first' })
    return client
  }
  const approver = (caller: Caller, group: string) => {
    if (caller.kind === 'agent' || !canApprove(caller, group))
      throw new ORPCError('FORBIDDEN', {
        message: 'only an approver of this group may connect an account',
      })
    return caller.kind === 'host' ? 'host' : `human:${caller.userId}`
  }
  const requestForState = (state: string) => {
    const row = db
      .select()
      .from(connectionRequest)
      .where(eq(connectionRequest.oauthState, state))
      .get()
    return row ? parseConnectionRequest(row) : undefined
  }
  const pageFor = (request: ConnectionRequest | undefined): CallbackPage => {
    if (!request || request.expiresAt <= new Date()) return { kind: 'unavailable' }
    if (request.state === 'cancelled') return { kind: 'cancelled' }
    if (request.state !== 'completed') return { kind: 'unavailable' }
    const held =
      request.accountId === null
        ? undefined
        : db.select().from(account).where(eq(account.id, request.accountId)).get()
    const granted = request.services.filter((service) => held?.services.includes(service))
    return {
      kind: 'completed',
      granted,
      missing: request.services.filter((service) => !granted.includes(service)),
    }
  }

  const connections = {
    setClient(client: z.infer<typeof GoogleClientSchema>) {
      transaction(db, (tx) => {
        const material = seal(vaultKey, clientAad, JSON.stringify(client))
        tx.insert(oauthClient)
          .values({ vendor: 'google', material, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: oauthClient.vendor,
            set: { material, updatedAt: new Date() },
          })
          .run()
        tx.update(connectionRequest)
          .set({ state: 'cancelled' })
          .where(
            and(
              eq(connectionRequest.vendor, 'google'),
              inArray(connectionRequest.state, ['open', 'authorizing']),
            ),
          )
          .run()
      })
    },
    createRequest(
      input: z.infer<typeof ConnectInputSchema> & { sessionId?: string },
      caller: Caller,
    ): string {
      const parsed = ConnectInputSchema.parse(input)
      if (parsed.services.some((service) => vendorOf(service) !== 'google'))
        throw new ORPCError('BAD_REQUEST', {
          message: '接続できるサービスは gmail と google-calendar です',
        })
      const groupId = caller.kind === 'agent' ? caller.agentGroupId : parsed.agentGroupId
      if (!groupId) throw new ORPCError('BAD_REQUEST', { message: 'agentGroupId is required' })
      const requestedBy =
        caller.kind === 'agent' ? `agent:${caller.agentGroupId}` : approver(caller, groupId)
      const sessionId = caller.kind === 'agent' ? caller.sessionId : (input.sessionId ?? null)
      const services = [...new Set(parsed.services)].toSorted()
      if (caller.kind === 'agent' && !cards)
        throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Connect Cards are unavailable' })
      return transaction(db, (tx) => {
        const group = tx.select().from(agentGroup).where(eq(agentGroup.id, groupId)).get()
        if (!group) throw new ORPCError('NOT_FOUND', { message: 'agent group not found' })
        clientOf()
        const now = new Date()
        if (caller.kind === 'agent') {
          const live = and(
            eq(connectionRequest.agentGroupId, groupId),
            eq(connectionRequest.vendor, 'google'),
            eq(connectionRequest.sessionId, caller.sessionId),
            inArray(connectionRequest.state, ['open', 'authorizing']),
          )
          tx.update(connectionRequest)
            .set({ state: 'expired' })
            .where(and(live, lte(connectionRequest.expiresAt, now)))
            .run()
          const existing = tx.select().from(connectionRequest).where(live).get()
          if (existing) {
            if (JSON.stringify(existing.services.toSorted()) === JSON.stringify(services))
              return existing.id
            tx.update(connectionRequest)
              .set({ state: 'cancelled' })
              .where(eq(connectionRequest.id, existing.id))
              .run()
          }
        }
        const reconnect = tx
          .select({ services: account.services })
          .from(account)
          .innerJoin(accountGrant, eq(account.id, accountGrant.accountId))
          .where(
            and(
              eq(account.vendor, 'google'),
              eq(account.status, 'needs_reauth'),
              eq(accountGrant.agentGroupId, groupId),
              inArray(accountGrant.service, services),
            ),
          )
          .all()
        const oauthServices = [
          ...new Set([...services, ...reconnect.flatMap((row) => row.services)]),
        ]
        const id = `cr-${Bun.randomUUIDv7()}`
        tx.insert(connectionRequest)
          .values({
            id,
            agentGroupId: groupId,
            services,
            oauthServices,
            vendor: 'google',
            sessionId,
            state: 'open',
            requestedBy,
            createdAt: now,
            expiresAt: new Date(now.getTime() + requestTtl),
          })
          .run()
        if (caller.kind === 'agent' && cards) {
          const cardMessageId = cards.post(tx, caller.sessionId, {
            owner: 'account.connect',
            ref: id,
            title: `${group.name} に Google を接続`,
            body: `接続するサービス: ${services.join(', ')}`,
            buttons: [{ action: 'connect', label: '接続する' }],
          })
          tx.update(connectionRequest)
            .set({ cardMessageId })
            .where(eq(connectionRequest.id, id))
            .run()
        }
        return id
      })
    },
    async connectAgent(
      input: z.infer<typeof ConnectInputSchema>,
      caller: Extract<Caller, { kind: 'agent' }>,
    ) {
      const requestId = connections.createRequest(input, caller)
      const row = db
        .select()
        .from(connectionRequest)
        .where(eq(connectionRequest.id, requestId))
        .get()
      if (row?.cardMessageId) await cards?.deliver(row.cardMessageId)
      return { kind: 'card_posted' as const, requestId }
    },
    press(
      { ref, action }: { ref: string; action: string },
      caller: Caller,
    ): { kind: 'private-link'; url: string } | { kind: 'notice'; text: string } {
      const row = db.select().from(connectionRequest).where(eq(connectionRequest.id, ref)).get()
      if (
        action !== 'connect' ||
        !row?.cardMessageId ||
        !['open', 'authorizing'].includes(row.state) ||
        row.expiresAt <= new Date()
      )
        return { kind: 'notice', text: 'このカードは利用できません。もう一度接続を頼んでください' }
      if (caller.kind === 'agent' || !canApprove(caller, row.agentGroupId))
        return { kind: 'notice', text: 'この group の承認者だけが接続できます' }
      const token = connections.issueLink(row.id, caller)
      return { kind: 'private-link', url: `http://127.0.0.1:${webPort}/connect/${token}` }
    },
    issueLink(requestId: string, caller: Caller): ConnectToken {
      return transaction(db, (tx) => {
        const row = tx
          .select()
          .from(connectionRequest)
          .where(eq(connectionRequest.id, requestId))
          .get()
        if (!row) throw new ORPCError('NOT_FOUND', { message: 'connection request not found' })
        const request = parseConnectionRequest(row)
        const mintedFor = approver(caller, request.agentGroupId)
        const now = new Date()
        if (
          (request.state !== 'open' && request.state !== 'authorizing') ||
          request.expiresAt <= now
        )
          throw new ORPCError('BAD_REQUEST', { message: 'run account connect again' })
        const token = tokenSchema.parse(randomBytes(32).toString('base64url'))
        tx.insert(connectLink)
          .values({
            tokenHash: hashOf(token),
            requestId,
            mintedFor,
            expiresAt: new Date(now.getTime() + linkTtl),
          })
          .run()
        return token
      })
    },
    connect(input: z.infer<typeof ConnectInputSchema>, caller: Caller): { url: string } {
      return transaction(db, () => {
        const id = connections.createRequest(input, caller)
        const token = connections.issueLink(id, caller)
        return { url: `http://127.0.0.1:${webPort}/connect/${token}` }
      })
    },
    openLink(token: string): OpenLink {
      if (!tokenSchema.safeParse(token).success) return { kind: 'unavailable' }
      return transaction(db, (tx): OpenLink => {
        const now = new Date()
        const link = tx
          .select()
          .from(connectLink)
          .where(eq(connectLink.tokenHash, hashOf(token)))
          .get()
        if (!link || link.usedAt !== null || link.expiresAt <= now) return { kind: 'unavailable' }
        const row = tx
          .select()
          .from(connectionRequest)
          .where(eq(connectionRequest.id, link.requestId))
          .get()
        if (!row) return { kind: 'unavailable' }
        const request = parseConnectionRequest(row)
        if (
          (request.state !== 'open' && request.state !== 'authorizing') ||
          request.expiresAt <= now
        )
          return { kind: 'unavailable' }
        if (
          request.state === 'authorizing' &&
          (request.authorizedBy ?? request.requestedBy) !== link.mintedFor
        )
          return { kind: 'unavailable' }
        const client = clientOf()
        const oauthState = request.state === 'authorizing' ? request.oauthState : createState()
        const verifier =
          request.state === 'authorizing'
            ? open(vaultKey, request.id, request.pkceVerifier)
            : createPkce().verifier
        const url = authorizeUrl({
          vendor: request.vendor,
          services: request.oauthServices ?? request.services,
          client,
          redirectUri,
          state: oauthState,
          challenge: s256Challenge(verifier),
        })
        if (request.state === 'open')
          tx.update(connectionRequest)
            .set({
              state: 'authorizing',
              authorizedBy: link.mintedFor,
              oauthState,
              pkceVerifier: seal(vaultKey, request.id, verifier),
            })
            .where(eq(connectionRequest.id, request.id))
            .run()
        tx.update(connectLink)
          .set({ usedAt: now })
          .where(eq(connectLink.tokenHash, link.tokenHash))
          .run()
        return { kind: 'authorize', url }
      })
    },
    async callback(url: URL): Promise<CallbackPage> {
      const state = url.searchParams.get('state')
      if (!state || url.searchParams.getAll('state').length !== 1) return { kind: 'unavailable' }
      const request = requestForState(state)
      if (!request || request.expiresAt <= new Date()) return { kind: 'unavailable' }
      if (request.state !== 'authorizing') return pageFor(request)
      const callback = readCallback(url, request.oauthState)
      if (callback.kind === 'invalid') return { kind: 'unavailable' }
      if (callback.kind === 'denied' && callback.error === 'access_denied') {
        return transaction(db, (tx): CallbackPage => {
          const current = requestForState(state)
          if (current?.state !== 'authorizing' || current.expiresAt <= new Date())
            return pageFor(current)
          tx.update(connectionRequest)
            .set({ state: 'cancelled', pkceVerifier: null })
            .where(eq(connectionRequest.id, current.id))
            .run()
          return { kind: 'cancelled' }
        })
      }
      const exchangeKey = JSON.stringify([state, callback.kind === 'code' ? callback.code : null])
      attempts.set(state, (attempts.get(state) ?? 0) + 1)
      try {
        if (callback.kind === 'denied')
          throw new OAuthError('Google consent failed', callback.error, 502)
        let pending = exchanges.get(exchangeKey)
        if (!pending) {
          pending = exchangeCode({
            vendor: request.vendor,
            client: clientOf(),
            code: callback.code,
            verifier: open(vaultKey, request.id, request.pkceVerifier),
            redirectUri,
            fetch: fetchImpl,
          })
          exchanges.set(exchangeKey, pending)
        }
        const tokens = await pending
        const identity = catalog.google.connect.oauth.identify(tokens)
        const services = servicesCovered(request.vendor, identity.grantedScopes)
        if (!request.services.some((service) => services.includes(service)))
          throw new OAuthError('Nothing was granted', 'nothing_granted', 502)
        const material = accountMaterial.parse({
          kind: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          grantedScopes: identity.grantedScopes,
        })
        const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000)
        const started = performance.now()
        const result = transaction(db, (tx): { page: CallbackPage; committed: boolean } => {
          const current = requestForState(state)
          if (current?.state !== 'authorizing' || current.expiresAt <= new Date())
            return { page: pageFor(current), committed: false }
          const previous = tx
            .select()
            .from(account)
            .where(and(eq(account.vendor, request.vendor), eq(account.subject, identity.subject)))
            .get()
          if (
            previous &&
            tx
              .select()
              .from(accountGrant)
              .where(
                and(
                  eq(accountGrant.accountId, previous.id),
                  ne(accountGrant.agentGroupId, current.agentGroupId),
                  notInArray(accountGrant.service, services),
                ),
              )
              .get()
          )
            throw new OAuthError(
              'Consent would remove another group’s services',
              'shared_services_missing',
              502,
            )
          const id = previous?.id ?? `acc-${Bun.randomUUIDv7()}`
          if (material.kind === 'oauth' && material.refreshToken === null && previous) {
            const stored = accountMaterial.parse(JSON.parse(open(vaultKey, id, previous.material)))
            if (stored.kind === 'oauth') material.refreshToken = stored.refreshToken
          }
          const values = {
            label: identity.label,
            services,
            material: seal(vaultKey, id, JSON.stringify(material)),
            accessExpiresAt: expiresAt,
            status: 'active',
          } satisfies Partial<typeof account.$inferInsert>
          tx.insert(account)
            .values({
              id,
              vendor: request.vendor,
              subject: identity.subject,
              kind: 'oauth',
              ...values,
              createdAt: new Date(),
            })
            .onConflictDoUpdate({ target: [account.vendor, account.subject], set: values })
            .run()
          tx.delete(accountGrant)
            .where(and(eq(accountGrant.accountId, id), notInArray(accountGrant.service, services)))
            .run()
          for (const service of current.services) {
            if (!services.includes(service)) continue
            const granted = grant(tx, {
              agentGroupId: current.agentGroupId,
              accountId: id,
              service,
              grantedBy: current.authorizedBy ?? current.requestedBy,
            })
            if (!granted.ok)
              throw new Error(`unable to grant connected account: ${granted.refusal}`)
            tx.update(accountGrant)
              .set({
                grantedBy: current.authorizedBy ?? current.requestedBy,
                grantedAt: new Date(),
              })
              .where(
                and(
                  eq(accountGrant.accountId, id),
                  eq(accountGrant.agentGroupId, current.agentGroupId),
                  eq(accountGrant.service, service),
                ),
              )
              .run()
          }
          tx.update(connectionRequest)
            .set({ state: 'completed', accountId: id, pkceVerifier: null })
            .where(eq(connectionRequest.id, current.id))
            .run()
          return { page: pageFor(requestForState(state)), committed: true }
        })
        if (result.committed)
          log({
            kind: 'account.connect.completed',
            requestId: request.id,
            transactionMs: performance.now() - started,
          })
        return result.page
      } catch (error) {
        log({
          kind: 'account.connect.failed',
          requestId: request.id,
          reason:
            error instanceof OAuthError
              ? error.code
              : error instanceof IdentifyError
                ? error.kind
                : error instanceof Error
                  ? error.name
                  : 'UnknownError',
        })
        if (
          !(
            error instanceof OAuthError ||
            error instanceof IdentifyError ||
            error instanceof z.ZodError
          )
        )
          throw error
        return transaction(db, (tx): CallbackPage => {
          const current = requestForState(state)
          if (current?.state !== 'authorizing' || current.expiresAt <= new Date())
            return pageFor(current)
          if (attempts.get(state) === 1)
            tx.update(connectionRequest)
              .set({ state: 'open', oauthState: null, pkceVerifier: null, authorizedBy: null })
              .where(eq(connectionRequest.id, current.id))
              .run()
          return {
            kind:
              error instanceof OAuthError && error.code === 'nothing_granted'
                ? 'nothing-granted'
                : 'failed',
          }
        })
      } finally {
        exchanges.delete(exchangeKey)
        const remaining = (attempts.get(state) ?? 1) - 1
        if (remaining === 0) attempts.delete(state)
        else attempts.set(state, remaining)
      }
    },
  }
  return connections
}

export type Connections = ReturnType<typeof createConnections>

export function sealedConnectionRows(db: Db): { id: string; material: Buffer }[] {
  return [
    ...db
      .select()
      .from(oauthClient)
      .all()
      .map(({ material }) => ({ id: clientAad, material })),
    ...db
      .select()
      .from(connectionRequest)
      .where(
        and(
          inArray(connectionRequest.state, ['open', 'authorizing']),
          gt(connectionRequest.expiresAt, new Date()),
        ),
      )
      .all()
      .flatMap(({ id, pkceVerifier }) =>
        pkceVerifier === null ? [] : [{ id, material: pkceVerifier }],
      ),
  ]
}
