// @kurumi/console/contract — human caller (Console owner). The account, approval, agent and schedule pages call
// those domains' procedures directly; this contract holds only what the Console itself stores.
import { eventIterator } from '@orpc/contract'
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const contract = {
  chats: { list: kc.meta({}) },
  messages: {
    list: kc.meta({}).input(z.object({ chatId: z.string(), before: z.string().optional() })),
    send: kc.meta({}).input(z.object({ chatId: z.string(), text: z.string() })),
  },
  files: { get: kc.meta({}).input(z.object({ id: z.string() })) },
  unread: { mark: kc.meta({}).input(z.object({ chatId: z.string(), messageId: z.string() })) },
  inbox: kc.meta({}),
  groupChats: {
    create: kc.meta({}).input(z.object({ name: z.string(), members: z.array(z.string()) })),
    remove: kc.meta({}).input(z.object({ id: z.string() })),
  },
  appearance: { set: kc.meta({}).input(z.object({ agentGroupId: z.string(), label: z.string().optional() })) },
  /** Replaces the hand-made SSE: one stream of "this chat changed" signals; the SPA re-reads. */
  events: kc.meta({}).output(eventIterator(z.object({ chatId: z.string() }))),
}
