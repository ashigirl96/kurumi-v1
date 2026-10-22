// @kurumi/session/contract
// One contract, three callers. `channel.*` is the host↔container channel (agent caller only). The
// `agent.tool` procedures become the runner's MCP tools by derivation (apps/runner/src/tools.ts).
import { CardSchema } from '@kurumi/chat/contract'
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export type SessionId = `ses-${string}` & { readonly __brand: 'SessionId' }

/**
 * A live container incarnation, as proven by its Session Token. Only session's `authenticate` constructs one
 * (the brand). Scope is the Session; the Agent Group is derived from it (grants are per group, approvals and
 * cards per session). A type, so account and gateway can take it without importing session's server entry.
 */
export type AgentPrincipal = {
  readonly containerId: string
  readonly sessionId: string
  readonly agentGroupId: string
  readonly __brand: 'AgentPrincipal'
}

export const InboundSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.enum(['chat', 'task', 'system', 'echo', 'answer']),
  trigger: z.boolean(),
  /** Already formatted for the model by the host (sender name, time, attachments as inbox paths). */
  content: z.unknown(),
})

export const OutboundBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('card'), card: CardSchema }),
  z.object({ kind: z.literal('task_log'), text: z.string() }),
])

export const contract = {
  // ── host↔container channel (agent: 'channel'): scoped to caller.sessionId by the guard ─────────────
  channel: {
    /**
     * Long poll (≤25 s). Returns due, triggered work plus the accumulated context before it, and marks the
     * rows processing+claimedBy=<this container> in one transaction. A second pull by the same incarnation
     * returns its still-processing rows again (runner restart inside the container is safe).
     */
    pull: kc
      .meta({ agent: 'channel' })
      .input(z.object({ waitMs: z.number().int().max(25_000).default(25_000) }))
      .output(z.object({ messages: z.array(InboundSchema) })),
    /** Marks rows completed. Error turns still complete (the error text was posted to the user). */
    complete: kc.meta({ agent: 'channel' }).input(z.object({ ids: z.array(z.string()) })),
    /** Idempotent by `id` (runner uuidv7). The runner retries until acked, across host restarts. */
    post: kc
      .meta({ agent: 'channel' })
      .input(z.object({ id: z.uuid(), to: z.string().nullable(), inReplyTo: z.string().optional(), body: OutboundBody })),
    heartbeat: kc
      .meta({ agent: 'channel' })
      .input(z.object({ currentTool: z.string().nullable(), toolTimeoutMs: z.number().int().nullable() })),
    state: {
      get: kc.meta({ agent: 'channel' }).input(z.object({ key: z.string() })).output(z.object({ value: z.string().nullable() })),
      put: kc.meta({ agent: 'channel' }).input(z.object({ key: z.string(), value: z.string() })),
    },
  },

  // ── agent tools (also usable by host/human where it makes sense) ──────────────────────────────────
  sendMessage: kc
    .meta({
      agent: 'channel',
      tool: { name: 'send_message', instructions: 'Send a message to a named destination (other chat or agent).' },
    })
    .input(z.object({ id: z.uuid(), to: z.string(), text: z.string() })),
  sendFile: kc
    .meta({ agent: 'channel', tool: { name: 'send_file', instructions: 'Upload a file to the chat or a destination.' } })
    .input(z.object({ id: z.uuid(), to: z.string().nullable(), file: z.file(), caption: z.string().optional() })),
  editMessage: kc
    .meta({ agent: 'channel', tool: { name: 'edit_message', instructions: 'Edit one of your earlier messages by seq.' } })
    .input(z.object({ seq: z.number().int(), text: z.string() })),
  addReaction: kc
    .meta({ agent: 'channel', tool: { name: 'add_reaction', instructions: 'React to a message by seq.' } })
    .input(z.object({ seq: z.number().int(), emoji: z.string() })),
  sendCard: kc
    .meta({ agent: 'channel', tool: { name: 'send_card', instructions: 'Show a card with link buttons.' } })
    .input(z.object({ id: z.uuid(), card: CardSchema })),
  /** Blocking question: returns when answered (long poll, re-callable with the same id after a restart). */
  askUserQuestion: kc
    .meta({ agent: 'channel', tool: { name: 'ask_user_question', instructions: 'Ask and wait for a choice.' } })
    .input(z.object({ id: z.uuid(), title: z.string(), options: z.array(z.string()).min(2) }))
    .output(z.object({ answer: z.string().nullable() })),
  postQuestion: kc
    .meta({ agent: 'channel', tool: { name: 'post_question', instructions: 'Ask without waiting; the answer arrives as a chat message.' } })
    .input(z.object({ id: z.uuid(), title: z.string(), options: z.array(z.string()).min(2) })),
  installPackages: kc
    .meta({ agent: 'hold', tool: { name: 'install_packages', instructions: 'Request apt/npm packages; needs approval, then you restart.' } })
    .input(z.object({ apt: z.array(z.string()).default([]), npm: z.array(z.string()).default([]), reason: z.string() })),
  addMcpServer: kc
    .meta({ agent: 'hold', tool: { name: 'add_mcp_server', instructions: 'Request an MCP server; needs approval.' } })
    .input(z.object({ name: z.string(), command: z.string(), args: z.array(z.string()), reason: z.string() })),

  // ── admin (host / human; agents per CLI Scope) ─────────────────────────────────────────────────────
  list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ agentGroupId: z.string().optional() })),
  show: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ sessionId: z.string() })),
  history: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ sessionId: z.string(), limit: z.number().int().default(50) })),
  restart: kc
    .meta({ cli: true, agent: 'scoped' })
    .input(z.object({ agentGroupId: z.string(), rebuild: z.boolean().default(false), message: z.string().optional() })),
  dropped: kc.meta({ cli: true }).input(z.object({})),
  policies: {
    list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({})),
    set: kc.meta({ cli: true }).input(z.object({ from: z.string(), to: z.string(), approverUserId: z.string().nullable() })),
    remove: kc.meta({ cli: true }).input(z.object({ from: z.string(), to: z.string() })),
  },
}
