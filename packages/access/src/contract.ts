import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

const userId = z
  .string()
  .max(255)
  .regex(/^[^:\s]+:\S+$/, 'user id must look like <kind>:<handle>, for example slack:U123')
  .regex(
    /^[^\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]*$/u,
    'user id must not contain control, format, or invisible characters',
  )

export const createUserInput = z.object({
  id: userId,
  displayName: z.string().trim().min(1).max(255),
})

const user = z.object({ id: z.string(), kind: z.string(), displayName: z.string() })

export const principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }),
  z.object({ kind: z.literal('user'), userId: z.string() }),
])
export type Principal = z.infer<typeof principal>

export const contract = {
  users: {
    create: kc
      .meta({ cli: true, agent: 'hold', description: 'Create a user (agents wait for approval)' })
      .input(createUserInput)
      .output(user),
  },
}
