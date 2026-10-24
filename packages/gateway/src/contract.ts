import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const egressDecisions = ['injected', 'passed', 'refused'] as const

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

export const contract = {
  status: kc
    .meta({ cli: true, description: 'Show the Agent Port admission, address, and CA fingerprint' })
    .output(GatewayStatusSchema),
  log: kc
    .meta({ cli: true, description: 'List the latest proxied requests, oldest first' })
    .input(EgressLogFilterSchema)
    .output(z.array(EgressLogRowSchema)),
}
