// @kurumi/agent/contract (`kurumi agent …`)
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export type AgentGroupId = `ag-${string}` & { readonly __brand: 'AgentGroupId' }

const Id = z.object({ agentGroupId: z.string() })

export const contract = {
  list: kc.meta({ cli: true, agent: 'scoped' }),
  show: kc.meta({ cli: true, agent: 'scoped' }).input(Id),
  create: kc
    .meta({ cli: true, agent: 'scoped', humanHold: 'agents.create' })
    .input(z.object({ name: z.string(), template: z.string().optional(), folder: z.string().optional() })),
  update: kc.meta({ cli: true }).input(Id.extend({ name: z.string().optional() })),
  /** Cascades grants, sessions, containers (FK) and revokes their Session Tokens. */
  remove: kc.meta({ cli: true }).input(Id),
  config: {
    get: kc.meta({ cli: true, agent: 'own-group' }).input(Id),
    update: kc.meta({ cli: true, agent: 'hold' }).input(Id.extend({ model: z.string().optional(), timezone: z.string().optional() })),
    addMount: kc.meta({ cli: true }).input(Id.extend({ hostPath: z.string(), containerPath: z.string(), readonly: z.boolean() })),
    removeMount: kc.meta({ cli: true }).input(Id.extend({ containerPath: z.string() })),
  },
  templates: { list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ registry: z.boolean().default(false) })) },
}
