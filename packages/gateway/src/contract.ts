import { HandleSchema, ServiceIdSchema } from '@kurumi/account/contract'
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const egressDecisions = ['injected', 'passed', 'refused', 'held'] as const

export const ruleEffects = ['approve', 'allow'] as const
export type RuleEffect = (typeof ruleEffects)[number]

export const admissionStates = ['binding', 'probing', 'open', 'unreachable', 'bind_failed'] as const

export const GatewayStatusSchema = z.object({
  admission: z.enum(admissionStates),
  detail: z.string().nullable(),
  agentPort: z.object({ host: z.string(), port: z.number().int() }),
  caFingerprint: z.string().describe('SHA-256 of the kurumi CA certificate'),
})

export type GatewayStatus = z.infer<typeof GatewayStatusSchema>

export const EgressLogFilterSchema = z.object({
  agentGroupId: z.string().min(1).optional(),
  account: z.string().min(1).optional().describe('account handle'),
  decision: z.enum(egressDecisions).optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
})

export type EgressLogFilter = z.infer<typeof EgressLogFilterSchema>

export const EgressLogRowSchema = z.object({
  at: z.date(),
  agentGroupId: z.string(),
  sessionId: z.string(),
  host: z.string(),
  method: z.string(),
  path: z.string(),
  account: z.string().nullable(),
  service: z.string().nullable(),
  decision: z.enum(egressDecisions),
  refusal: z.string().nullable(),
  status: z.number().int().nullable(),
  durationMs: z.number().int(),
})

export type EgressLogRow = z.infer<typeof EgressLogRowSchema>

export const RuleInputSchema = z.object({
  account: HandleSchema.optional().describe(
    'account handle the rule covers, such as anthropic/main',
  ),
  service: ServiceIdSchema.optional().describe('service the rule covers, every account of it'),
  host: z
    .string()
    .min(1)
    .optional()
    .describe('exact host; wildcards are refused; any host of the target when left out'),
  method: z.string().min(1).optional().describe('HTTP method; any when left out'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('exact path, or /prefix/* for a segment and everything under it; any when left out'),
  priority: z.number().int().default(0).describe('higher runs first'),
  effect: z
    .enum(ruleEffects)
    .default('approve')
    .describe('approve holds a matching request for a person; allow lets it through'),
})

export type RuleInput = z.infer<typeof RuleInputSchema>

export const RuleViewSchema = z.object({
  id: z.string(),
  priority: z.number().int(),
  effect: z.enum(ruleEffects),
  account: z.string().nullable(),
  service: z.string().nullable(),
  host: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  createdAt: z.date(),
})

export type RuleView = z.infer<typeof RuleViewSchema>

export const contract = {
  status: kc
    .meta({ cli: true, description: 'Show the Agent Port admission, address, and CA fingerprint' })
    .output(GatewayStatusSchema),
  log: kc
    .meta({ cli: true, description: 'List the latest proxied requests, oldest first' })
    .input(EgressLogFilterSchema)
    .output(z.array(EgressLogRowSchema)),
  rules: {
    list: kc
      .meta({
        cli: true,
        description: 'List egress rules in evaluation order; the first match wins',
      })
      .output(z.array(RuleViewSchema)),
    add: kc
      .meta({ cli: true, description: 'Add an egress rule on one account or one service' })
      .input(RuleInputSchema)
      .output(RuleViewSchema),
    remove: kc
      .meta({ cli: true, description: 'Remove an egress rule' })
      .input(z.tuple([z.string().describe('rule id')]))
      .output(z.object({ removed: z.boolean() })),
  },
}
