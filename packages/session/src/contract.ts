import { z } from 'zod'

export const sessionId = z.string().startsWith('ses-').min(5).brand<'SessionId'>()
export type SessionId = z.infer<typeof sessionId>

export type AgentPrincipal = {
  readonly containerId: string
  readonly sessionId: SessionId
  readonly agentGroupId: string
  readonly __brand: 'AgentPrincipal'
}
