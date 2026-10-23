import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

const userId = z
  .string()
  .max(255)
  .regex(/^[^:\s]+:\S+$/, 'user id must look like <kind>:<handle>, for example slack:U123')

export const createUserInput = z.object({
  id: userId,
  displayName: z.string().trim().min(1).max(255),
})

const user = z.object({ id: z.string(), kind: z.string(), displayName: z.string() })

export const contract = {
  users: {
    create: kc
      .meta({ cli: true, agent: 'hold', description: 'Create a user (agents wait for approval)' })
      .input(createUserInput)
      .output(user),
  },
}
