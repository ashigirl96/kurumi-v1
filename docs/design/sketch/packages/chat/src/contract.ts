// @kurumi/chat/contract
// Messaging Groups, Wirings, Destinations, and the platform-neutral Card every channel renders.
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

/**
 * A card is data; Slack renders Block Kit, Console renders React. Host-built cards (connect, approval) use only
 * action buttons; link buttons appear only on the agent's own `send_card`, rendered as the agent's message.
 */
/** Domains that own card actions. The host's dispatch map is `Record<CardOwner, …>`, so a new owner without a handler does not compile. */
export const CardOwnerSchema = z.enum(['approval', 'account', 'session'])
export type CardOwner = z.infer<typeof CardOwnerSchema>

export const CardButtonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('link'), label: z.string(), url: z.url() }),
  /** Routed to one domain's onCardAction by `owner` (host composes the owner map). */
  z.object({
    kind: z.literal('action'),
    label: z.string(),
    owner: CardOwnerSchema,
    action: z.string(),
    id: z.string(),
    value: z.string().optional(),
    style: z.enum(['primary', 'danger']).optional(),
  }),
])

export const CardSchema = z.object({
  title: z.string(),
  body: z.array(z.string()),
  buttons: z.array(CardButtonSchema),
  /** Final cards have no buttons and say how it ended. */
  final: z.boolean().default(false),
})

export type Card = z.input<typeof CardSchema>

export type CardAction = { owner: CardOwner; action: string; id: string; value?: string }

/**
 * What the clicker alone sees after a click. Slack: an ephemeral message (with a link button for private-link);
 * Console: a toast, or navigation for private-link. Nobody else in the chat sees it.
 */
export type CardActionReply =
  | { kind: 'none' }
  | { kind: 'private-text'; text: string }
  | { kind: 'private-link'; label: string; url: string }

const Engage = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('mention') }),
  z.object({ mode: z.literal('mention-sticky') }),
  z.object({ mode: z.literal('pattern'), pattern: z.string() }),
])

export const contract = {
  messagingGroups: {
    list: kc.meta({ cli: true, agent: 'scoped' }),
    show: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ id: z.string() })),
    create: kc
      .meta({ cli: true })
      .input(z.object({ channel: z.string(), platformId: z.string(), instance: z.string().optional(), name: z.string() })),
    update: kc.meta({ cli: true }).input(
      z.object({
        id: z.string(),
        unknownSenderPolicy: z.enum(['strict', 'request_approval', 'decline_notify', 'public']).optional(),
      }),
    ),
    remove: kc.meta({ cli: true }).input(z.object({ id: z.string() })),
    /** Post as the agent into a chat (welcome message etc.). */
    send: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ id: z.string(), text: z.string() })),
  },
  wirings: {
    list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ agentGroupId: z.string().optional() })),
    create: kc.meta({ cli: true, agent: 'scoped', humanHold: 'wirings.create' }).input(
      z.object({
        messagingGroupId: z.string(),
        agentGroupId: z.string(),
        engage: Engage,
        sessionMode: z.enum(['shared', 'per-thread', 'agent-shared']),
        senderScope: z.enum(['all', 'known']),
        accumulate: z.boolean(),
        threads: z.boolean().nullable(),
      }),
    ),
    update: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ id: z.string(), engage: Engage.optional() })),
    remove: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ id: z.string() })),
  },
  destinations: {
    list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ agentGroupId: z.string() })),
    add: kc.meta({ cli: true, agent: 'scoped' }).input(
      z.object({
        agentGroupId: z.string(),
        name: z.string(),
        target: z.union([z.object({ messagingGroupId: z.string() }), z.object({ agentGroupId: z.string() })]),
      }),
    ),
    remove: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ agentGroupId: z.string(), name: z.string() })),
  },
  userDms: { list: kc.meta({ cli: true }) },
  /** Terminal chat (`kurumi chat <group>`): no agent/human meta beyond host use; streams the agent's replies. */
  terminal: kc.meta({}).input(z.object({ agentGroupId: z.string(), text: z.string() })),
}
