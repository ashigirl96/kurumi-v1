import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

import { keyVendorIds, serviceIds, vendorOf } from './catalog.ts'

export const ServiceIdSchema = z.enum(serviceIds)
export const HandleSchema = z.string().min(1).describe('handle')

export const KEY_MAX_LENGTH = 4096

export const GoogleClientSchema = z.object({
  clientId: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  clientSecret: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
})

const ClientStdinSchema = z
  .string()
  .min(1)
  .max(16384)
  .transform((value, ctx) => {
    try {
      const parsed = GoogleClientSchema.safeParse(JSON.parse(value))
      if (parsed.success) return parsed.data
    } catch {}
    ctx.addIssue({ code: 'custom', message: 'stdin must be JSON with clientId and clientSecret' })
    return z.NEVER
  })
  .meta({ stdin: true })

export const ConnectInputSchema = z.object({
  services: z
    .array(ServiceIdSchema)
    .min(1)
    .refine(
      (services) => services.every((service) => vendorOf(service) === 'google'),
      'only Google services are supported',
    ),
  agentGroupId: z.string().min(1),
})

export const ConnectOutputSchema = z.object({ url: z.url() })

/** A key ends up in an HTTP header value, which carries only visible ASCII safely. */
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
  services: z.array(ServiceIdSchema),
  autoGrant: z.boolean(),
  status: z.enum(['active', 'needs_reauth']),
})

export const MyAccountSchema = z.object({
  handle: HandleSchema,
  selector: z.string(),
  service: ServiceIdSchema,
  isDefault: z.boolean(),
  status: z.enum(['active', 'needs_reauth']),
})

export const contract = {
  setClient: kc
    .meta({ cli: true, description: 'Set the Google OAuth client, reading JSON from stdin' })
    .input(
      z.tuple([z.literal('google').describe('vendor'), z.object({ client: ClientStdinSchema })]),
    ),
  connect: kc
    .meta({ cli: true, description: 'Issue a one-time Google account connection link' })
    .input(ConnectInputSchema)
    .output(ConnectOutputSchema),
  mine: kc
    .meta({
      agent: 'own-group',
      tool: {
        name: 'list_accounts',
        instructions:
          'Lists the accounts you may use, per service. A selector is a public placeholder, not a credential. Put it where a bearer token or API key goes; the gateway swaps it for the real credential when the request goes through the Agent Port. With no selector, the only or default account is used.',
      },
    })
    .output(z.object({ accounts: z.array(MyAccountSchema) })),
  addKey: kc
    .meta({ cli: true, description: 'Add a key account, reading the key from stdin' })
    .input(
      z.tuple([
        z.enum(keyVendorIds).describe('vendor'),
        z.object({
          label: z.string().min(1),
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
