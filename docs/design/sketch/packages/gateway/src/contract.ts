// @kurumi/gateway/contract
import { HandleSchema, ServiceIdSchema } from '@kurumi/account/contract'
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

/** Exactly one target — same rule as the egress_rule CHECK. */
const RuleTarget = z.union([
  z.object({ account: HandleSchema }),
  z.object({ service: ServiceIdSchema }),
  z.object({ host: z.string().describe('exact or *.suffix') }),
])

export const contract = {
  status: kc.meta({ cli: true }).output(
    z.object({
      admission: z.discriminatedUnion('open', [
        z.object({ open: z.literal(true) }),
        z.object({
          open: z.literal(false),
          reason: z.enum(['binding', 'probing', 'unreachable', 'bind_failed']),
          detail: z.string(),
          since: z.date(),
        }),
      ]),
      agentPort: z.object({ host: z.string(), port: z.number() }),
      caFingerprint: z.string(),
      holds: z.number().int(),
    }),
  ),
  rules: {
    list: kc.meta({ cli: true }).input(z.object({ agentGroupId: z.string().optional() })),
    add: kc.meta({ cli: true }).input(
      z.object({
        priority: z.number().int(),
        agentGroupId: z.string().nullable(),
        target: RuleTarget,
        method: z.string().nullable(),
        path: z.string().nullable(),
        effect: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('allow') }),
          z.object({ kind: z.literal('block') }),
          z.object({ kind: z.literal('approve') }),
          z.object({ kind: z.literal('rate_limit'), perMinute: z.number().int().positive() }),
        ]),
      }),
    ),
    remove: kc.meta({ cli: true }).input(z.object({ id: z.string() })),
  },
  log: kc
    .meta({ cli: true })
    .input(z.object({ agentGroupId: z.string().optional(), account: z.string().optional(), limit: z.number().int().default(100) })),
}
