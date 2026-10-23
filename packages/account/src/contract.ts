import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

import { authModeIds, keyVendorIds, serviceIds } from './catalog.ts'

export const ServiceIdSchema = z.enum(serviceIds)
export const HandleSchema = z.string().min(1).describe('handle')

export const KEY_MAX_LENGTH = 4096

/** A key ends up in an HTTP header or query string, which carry only visible ASCII safely. */
const KeyValueSchema = z
  .string()
  .min(1, 'value is empty')
  .max(KEY_MAX_LENGTH, `value is longer than ${KEY_MAX_LENGTH} characters`)
  .refine((value) => !/\s/.test(value), { message: 'value contains whitespace', abort: true })
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: 'value contains a control character',
    abort: true,
  })
  .refine((value) => /^[\x21-\x7e]*$/.test(value), 'value contains a non-ASCII character')

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
          value: KeyValueSchema.meta({ stdin: true }),
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
