// apps/runner — runs INSIDE the container (Bun). Hostile territory: it holds only its Session Token.
// It has no SQLite, no mailbox files: every exchange with the host is a typed oRPC call to the Agent Port.
//
//   env (from the gateway's contribution):
//     KURUMI_URL=http://host.docker.internal:<port>   KURUMI_TOKEN=<session token>
//     HTTPS_PROXY=http://s:<token>@host.docker.internal:<port>   NO_PROXY=host.docker.internal
//     NODE_EXTRA_CA_CERTS / SSL_CERT_FILE = /etc/kurumi/ca.pem   ANTHROPIC_API_KEY=<selector of anthropic/<label>>
import type { ContractRouterClient } from '@orpc/contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

import type { contract as sessionContract } from '@kurumi/session/contract'

type Host = ContractRouterClient<{ session: typeof sessionContract }>

export function connectHost(env: { KURUMI_URL: string; KURUMI_TOKEN: string }): Host {
  return createORPCClient(
    new RPCLink({ url: `${env.KURUMI_URL}/rpc`, headers: { authorization: `Bearer ${env.KURUMI_TOKEN}` } }),
  )
}

/**
 * The loop nanoclaw's poll-loop.ts ran over inbound.db, now over RPC:
 *
 *   loop:
 *     { messages } = await host.session.channel.pull({ waitMs: 25_000 })   // long poll; retries with backoff
 *                                                                            // while the host restarts
 *     if no triggered message → continue (Accumulate rows are context only)
 *     run Claude Agent SDK query (resume from channel.state 'continuation'), streaming follow-ups that arrive
 *     on further pulls during the turn into the live query
 *     each `<message to>` block / tool call → host.session.channel.post({ id: uuidv7(), … })
 *        posts are retried until acked; `id` makes a retry after a host restart a no-op
 *     heartbeat every 10 s with current tool + declared timeout
 *     finally: channel.state.put('continuation'), channel.complete({ ids })   // errors complete too
 *
 * Container death mid-turn: the host reaps the incarnation and returns its processing rows to pending
 * (at-least-once, as nanoclaw). The old container's token is revoked, so it cannot pull a follow-up
 * meant for its replacement (what nanoclaw's on_wake row protected against).
 */
export async function main(): Promise<never> {
  throw new Error('not implemented')
}
