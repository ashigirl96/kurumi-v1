import { oc } from '@orpc/contract'
import { z } from 'zod'

export type Caller =
  | { kind: 'host' }
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; agentGroupId: string; sessionId: string }

export type AgentCaller = Extract<Caller, { kind: 'agent' }>
export type AgentAccess = 'channel' | 'own-group' | 'scoped' | 'hold'

export type Meta = {
  description?: string
  cli?: boolean
  agent?: AgentAccess
  tool?: { name: string; instructions: string }
  humanHold?: string
}

export const kc = oc.$meta<Meta>({})

export const hostContract = {
  status: kc
    .meta({ cli: true, description: 'Check whether the host is ready' })
    .output(z.object({ ready: z.literal(true) })),
  db: {
    query: kc
      .meta({ cli: true, description: 'Run a read-only SQL query' })
      .input(z.tuple([z.string().describe('SQL')]))
      .output(z.array(z.record(z.string(), z.unknown()))),
  },
}
