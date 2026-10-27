import { randomBytes } from 'node:crypto'

import { agentGroup } from '@kurumi/agent/schema'
import type { Caller } from '@kurumi/rpc/contract'
import { transaction, type Db } from '@kurumi/rpc/server'
import { ORPCError } from '@orpc/server'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { ConnectInputSchema, GoogleClientSchema } from './contract.ts'
import { authorizeUrl, createPkce, createState, s256Challenge } from './oauth.ts'
import { connectionRequest, connectLink, oauthClient } from './schema.ts'
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
}

type OpenLink = { kind: 'authorize'; url: URL } | { kind: 'unavailable' }

export function createConnections({
  db,
  vaultKey,
  webPort = 4001,
  canApprove = (caller) => caller.kind === 'host',
}: {
  db: Db
  vaultKey: Uint8Array
} & ConnectionOptions) {
  const redirectUri = `http://127.0.0.1:${webPort}/oauth/callback`
  const clientOf = () => {
    const row = db.select().from(oauthClient).where(eq(oauthClient.vendor, 'google')).get()
    if (!row) throw new ORPCError('BAD_REQUEST', { message: 'run account set-client google first' })
    return GoogleClientSchema.parse(JSON.parse(open(vaultKey, clientAad, row.material)))
  }
  const approver = (caller: Caller, group: string) => {
    if (caller.kind === 'agent' || !canApprove(caller, group))
      throw new ORPCError('FORBIDDEN', {
        message: 'only an approver of this group may connect an account',
      })
    return caller.kind === 'host' ? 'host' : `human:${caller.userId}`
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
      const requestedBy = approver(caller, input.agentGroupId)
      const parsed = ConnectInputSchema.parse(input)
      return transaction(db, (tx) => {
        if (!tx.select().from(agentGroup).where(eq(agentGroup.id, parsed.agentGroupId)).get())
          throw new ORPCError('NOT_FOUND', { message: 'agent group not found' })
        clientOf()
        const id = `cr-${Bun.randomUUIDv7()}`
        const now = new Date()
        tx.insert(connectionRequest)
          .values({
            id,
            ...parsed,
            services: [...new Set(parsed.services)],
            vendor: 'google',
            sessionId: input.sessionId ?? null,
            state: 'open',
            requestedBy,
            createdAt: now,
            expiresAt: new Date(now.getTime() + requestTtl),
          })
          .run()
        return id
      })
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
        const client = clientOf()
        const oauthState = request.state === 'authorizing' ? request.oauthState : createState()
        const verifier =
          request.state === 'authorizing'
            ? open(vaultKey, request.id, request.pkceVerifier)
            : createPkce().verifier
        const url = authorizeUrl({
          vendor: request.vendor,
          services: request.services,
          client,
          redirectUri,
          state: oauthState,
          challenge: s256Challenge(verifier),
        })
        if (request.state === 'open')
          tx.update(connectionRequest)
            .set({
              state: 'authorizing',
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
