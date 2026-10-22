// @kurumi/schedule/contract (`kurumi schedule …`, agent tools schedule_task / list_tasks / cancel_task)
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

const Id = z.object({ seriesId: z.string() })

export const contract = {
  list: kc.meta({ cli: true, agent: 'scoped', tool: { name: 'list_tasks', instructions: 'List scheduled tasks of your group.' } }).input(z.object({ agentGroupId: z.string().optional() })),
  show: kc.meta({ cli: true, agent: 'scoped' }).input(Id),
  /** cron: ≤4 runs per 24 h unless script-gated or `override`. */
  create: kc
    .meta({ cli: true, agent: 'scoped', tool: { name: 'schedule_task', instructions: 'Schedule a one-shot or cron task; output must name a destination.' } })
    .input(
      z.object({
        agentGroupId: z.string().optional(),
        prompt: z.string(),
        at: z.date().optional(),
        recurrence: z.string().optional(),
        script: z.string().optional(),
        override: z.boolean().default(false),
      }),
    ),
  update: kc.meta({ cli: true, agent: 'scoped' }).input(Id.extend({ prompt: z.string().optional(), recurrence: z.string().optional() })),
  cancel: kc.meta({ cli: true, agent: 'scoped', tool: { name: 'cancel_task', instructions: 'Cancel a scheduled task.' } }).input(Id),
  pause: kc.meta({ cli: true, agent: 'scoped' }).input(Id),
  resume: kc.meta({ cli: true, agent: 'scoped' }).input(Id),
  run: kc.meta({ cli: true, agent: 'scoped' }).input(Id),
  appendLog: kc.meta({ cli: true, agent: 'scoped' }).input(Id.extend({ text: z.string() })),
}
