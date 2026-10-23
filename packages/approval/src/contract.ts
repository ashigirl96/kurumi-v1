import { principal } from '@kurumi/access/contract'
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const approvalKinds = ['procedure', 'gateway.request'] as const
export type ApprovalKind = (typeof approvalKinds)[number]

export const approvalStatuses = ['pending', 'approved', 'denied'] as const
export type ApprovalStatus = (typeof approvalStatuses)[number]
export type ApprovalDecision = 'approve' | 'deny'

const common = {
  id: z.string(),
  kind: z.enum(approvalKinds),
  title: z.string(),
  agentGroupId: z.string().nullable(),
  sessionId: z.string().nullable(),
  body: z.array(z.string()),
  approvers: z.array(principal),
  createdAt: z.date(),
}

export const approvalView = z.discriminatedUnion('status', [
  z.object({ ...common, status: z.literal('pending') }),
  z.object({
    ...common,
    status: z.enum(['approved', 'denied']),
    decidedBy: principal,
    decidedAt: z.date(),
    handledAt: z.date().nullable(),
    handlerError: z.string().nullable(),
  }),
])
export type ApprovalView = z.infer<typeof approvalView>

const approvalId = z.string().describe('approval id')

export const contract = {
  list: kc
    .meta({ cli: true, description: 'List approvals' })
    .input(z.object({ status: z.enum(['pending', 'decided']).default('pending') }))
    .output(z.array(approvalView)),
  show: kc
    .meta({ cli: true, description: 'Show one approval' })
    .input(z.tuple([approvalId]))
    .output(approvalView),
  decide: kc
    .meta({ cli: true, description: 'Approve or deny a pending approval' })
    .input(
      z
        .tuple([
          approvalId,
          z.object({ approve: z.boolean().optional(), deny: z.boolean().optional() }),
        ])
        .refine(([, flags]) => (flags.approve === true) !== (flags.deny === true), {
          message: 'pass exactly one of --approve or --deny',
        }),
    )
    .output(z.object({ changed: z.boolean(), message: z.string(), approval: approvalView })),
}
