import { kc } from '@kurumi/rpc/contract'
import { eventIterator } from '@orpc/contract'
import { z } from 'zod'

export const terminalInput = z.object({
  agentGroupId: z.string().startsWith('ag-').min(4),
  text: z.string(),
  follow: z.boolean().default(false),
})

const inboundReceipt = z.object({
  sessionId: z.string(),
  inboundId: z.string(),
  seq: z.number().int().positive(),
})

export const terminalEvent = z.discriminatedUnion('kind', [
  inboundReceipt.extend({ kind: z.literal('queued') }),
  z.object({ kind: z.literal('reply'), outboundId: z.string(), text: z.string() }),
])

export type TerminalInput = z.output<typeof terminalInput>
export type InboundReceipt = z.infer<typeof inboundReceipt>
export type TerminalEvent = z.infer<typeof terminalEvent>
export type InboundEvent = {
  channel: 'terminal'
  instance: null
  platformId: string
  threadId: null
  messageId: string
  receivedAt: number
  text: string
  sender: { handle: string; displayName: string; isBot: false }
  isMention: true
  isGroup: false
  attachments: []
}
export type DeliveryTarget = {
  channel: string
  instance: string | null
  platformId: string
  threadId: string | null
}
export type ChannelAdapter = {
  readonly kind: string
  readonly instance: string | null
  readonly ownerOnly: boolean
  post(
    target: DeliveryTarget,
    body: { id: string; text: string },
  ): Promise<{ platformMessageId: string }>
}

export const contract = {
  terminal: kc.meta({}).input(terminalInput).output(eventIterator(terminalEvent)),
}
