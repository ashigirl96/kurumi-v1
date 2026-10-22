// @kurumi/approval/contract
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const contract = {
  list: kc.meta({ cli: true }).input(z.object({ status: z.enum(['pending', 'decided']).default('pending') })),
  show: kc.meta({ cli: true }).input(z.object({ id: z.string() })),
  /** Same transition as a card click; the Console Inbox and the CLI use it. Checked against the baked approvers. */
  decide: kc
    .meta({ cli: true })
    .input(z.object({ id: z.string(), decision: z.enum(['approve', 'reject']), reason: z.string().optional() })),
}
