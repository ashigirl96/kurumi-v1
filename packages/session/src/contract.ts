import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const sessionId = z.string().startsWith('ses-').min(5).brand<'SessionId'>()
export type SessionId = z.infer<typeof sessionId>

export type AgentPrincipal = {
  readonly containerId: string
  readonly sessionId: SessionId
  readonly agentGroupId: string
  readonly __brand: 'AgentPrincipal'
}

export const pullInput = z.strictObject({
  waitMs: z.number().int().min(0).max(25_000).default(25_000),
})
export const completeInput = z.strictObject({
  ids: z.array(z.string().min(1)).min(1).max(100),
  status: z.enum(['completed', 'failed']).optional(),
})
export const postInput = z.strictObject({
  id: z.string().min(1),
  inReplyTo: z.string().min(1),
  body: z.strictObject({ kind: z.literal('text'), text: z.string() }),
  to: z.null().optional(),
})
export const heartbeatInput = z.strictObject({
  currentTool: z.string().nullable(),
  toolTimeoutMs: z.number().int().min(0).max(86_400_000).nullable(),
})
export const stateKeyInput = z.strictObject({ key: z.string().min(1) })
export const statePutInput = stateKeyInput.extend({ value: z.string() })
const inbound = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  kind: z.enum(['chat', 'task', 'system', 'echo', 'answer']),
  trigger: z.boolean(),
  content: z.string(),
})
export type Inbound = z.infer<typeof inbound>
export type PullInput = z.input<typeof pullInput>
export type CompleteInput = z.infer<typeof completeInput>
export type PostInput = z.infer<typeof postInput>
export type HeartbeatInput = z.infer<typeof heartbeatInput>
export type StateKeyInput = z.infer<typeof stateKeyInput>
export type StatePutInput = z.infer<typeof statePutInput>

export const contract = {
  channel: {
    pull: kc
      .meta({ agent: 'channel' })
      .input(pullInput)
      .output(z.object({ messages: z.array(inbound) })),
    complete: kc.meta({ agent: 'channel' }).input(completeInput).output(z.void()),
    post: kc.meta({ agent: 'channel' }).input(postInput).output(z.void()),
    heartbeat: kc.meta({ agent: 'channel' }).input(heartbeatInput).output(z.void()),
    state: {
      get: kc
        .meta({ agent: 'channel' })
        .input(stateKeyInput)
        .output(z.object({ value: z.string().nullable() })),
      put: kc.meta({ agent: 'channel' }).input(statePutInput).output(z.void()),
    },
  },
}
