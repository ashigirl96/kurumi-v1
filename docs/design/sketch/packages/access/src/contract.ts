// @kurumi/access/contract (`kurumi access users|roles|members …`). Humans only, except listing.
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const contract = {
  users: {
    list: kc.meta({ cli: true, agent: 'scoped' }),
    update: kc.meta({ cli: true }).input(z.object({ userId: z.string(), displayName: z.string() })),
  },
  roles: {
    list: kc.meta({ cli: true }),
    grant: kc.meta({ cli: true }).input(z.object({ userId: z.string(), role: z.enum(['owner', 'admin']), agentGroupId: z.string().nullable() })),
    revoke: kc.meta({ cli: true }).input(z.object({ userId: z.string(), role: z.enum(['owner', 'admin']), agentGroupId: z.string().nullable() })),
  },
  members: {
    list: kc.meta({ cli: true, agent: 'scoped' }).input(z.object({ agentGroupId: z.string() })),
    add: kc.meta({ cli: true }).input(z.object({ userId: z.string(), agentGroupId: z.string() })),
    remove: kc.meta({ cli: true }).input(z.object({ userId: z.string(), agentGroupId: z.string() })),
  },
}
