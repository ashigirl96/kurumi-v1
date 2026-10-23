import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export type AgentGroupId = `ag-${string}` & { readonly __brand: 'AgentGroupId' }

const folderName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\\0]+$/, 'folder must be a single directory name')
  .refine((value) => value !== '.' && value !== '..', 'folder must be a single directory name')

export const createAgentInput = z
  .object({
    name: z.string().trim().min(1).max(255),
    folder: folderName.optional(),
  })
  .superRefine((input, context) => {
    if (input.folder === undefined && !folderName.safeParse(input.name).success) {
      context.addIssue({
        code: 'custom',
        path: ['folder'],
        message: 'provide a folder with a single directory name',
      })
    }
  })

const agentGroup = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.string(),
  createdAt: z.date(),
})

export const contract = {
  list: kc
    .meta({ cli: true, agent: 'scoped', description: 'List agent groups' })
    .output(z.array(agentGroup)),
  create: kc
    .meta({
      cli: true,
      agent: 'scoped',
      humanHold: 'agents.create',
      description: 'Create an agent group',
    })
    .input(createAgentInput)
    .output(agentGroup),
}
