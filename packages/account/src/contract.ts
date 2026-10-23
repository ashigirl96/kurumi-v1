import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

import { authModeIds, keyVendorIds, serviceIds } from './catalog.ts'

export const ServiceIdSchema = z.enum(serviceIds)
export const HandleSchema = z.string().min(1).describe('handle')

const GrantTarget = z.object({ service: ServiceIdSchema, agentGroupId: z.string().min(1) })

export const AddKeyOutputSchema = z.object({ handle: z.string() })

export const AccountViewSchema = z.object({
  handle: z.string(),
  kind: z.enum(['oauth', 'key']),
  authMode: z.enum(authModeIds).nullable(),
  services: z.array(ServiceIdSchema),
  autoGrant: z.boolean(),
})

export const contract = {
  addKey: kc
    .meta({ cli: true, description: 'Add a key account, reading the key from stdin' })
    .input(
      z.tuple([
        z.enum(keyVendorIds).describe('vendor'),
        z.object({
          label: z.string().min(1),
          auth: z.enum(authModeIds).optional(),
          autoGrant: z.boolean().default(false),
          value: z.string().min(1).meta({ stdin: true }),
        }),
      ]),
    )
    .output(AddKeyOutputSchema),
  list: kc.meta({ cli: true, description: 'List accounts' }).output(z.array(AccountViewSchema)),
  remove: kc
    .meta({ cli: true, description: 'Remove an account with its grants and defaults' })
    .input(z.tuple([HandleSchema])),
  grant: kc
    .meta({ cli: true, description: 'Grant an account to an agent group for a service' })
    .input(z.tuple([HandleSchema, GrantTarget])),
  revoke: kc
    .meta({ cli: true, description: 'Revoke an account from an agent group for a service' })
    .input(z.tuple([HandleSchema, GrantTarget])),
  setDefault: kc
    .meta({ cli: true, description: "Make an account the group's default for a service" })
    .input(z.tuple([HandleSchema, GrantTarget])),
  clearDefault: kc
    .meta({ cli: true, description: "Clear the group's default account for a service" })
    .input(GrantTarget),
}
