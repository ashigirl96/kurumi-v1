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

export const personaLimit = 16000

export const updateAgentInput = z.object({
  agentGroupId: z.string().min(1),
  persona: z
    .string()
    .max(personaLimit * 2)
    .refine(
      (value) => Array.from(value).length <= personaLimit,
      'persona must be at most 16000 Unicode characters',
    ),
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
  update: kc
    .meta({ cli: true, description: 'Update an agent group persona' })
    .input(updateAgentInput)
    .output(agentGroup),
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
