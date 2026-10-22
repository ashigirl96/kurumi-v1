// @kurumi/account/contract
// No procedure returns key material: the schemas below are the only shapes that cross the boundary,
// and none has a field for it.
import { kc } from '@kurumi/rpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { serviceIds, vendorIds } from './catalog.ts'
import { account } from './schema.ts'

export type { ServiceId, VendorId } from './catalog.ts'
export type { AccountHandle, SelectionRefusal } from './select.ts'
export type { ConnectionRequestId } from './connect.ts'

const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })
const AccountRow = createSelectSchema(account)

export const VendorIdSchema = z.enum(vendorIds)
export const ServiceIdSchema = z.enum(serviceIds)
export const HandleSchema = z
  .string()
  .regex(/^[a-z0-9-]+\/.+$/)
  .describe('<vendor>/<label>, e.g. google/alice@work.example')

export const AccountSchema = z.object({
  handle: HandleSchema,
  vendor: VendorIdSchema,
  label: AccountRow.shape.label,
  kind: AccountRow.shape.kind,
  services: z.array(ServiceIdSchema),
  status: AccountRow.shape.status,
  autoGrant: AccountRow.shape.autoGrant,
  grants: z.array(z.object({ agentGroupId: z.string(), service: ServiceIdSchema, isDefault: z.boolean() })),
})

/** What an agent sees about its own group: no other group's accounts, no ids. */
export const MyAccountSchema = z.object({
  handle: HandleSchema,
  /** The exact string to put in the credential slot (vendor's selector shape applied). */
  selector: z.string(),
  service: ServiceIdSchema,
  isDefault: z.boolean(),
  status: AccountRow.shape.status,
})

const RequestState = z.enum(['open', 'authorizing', 'completed', 'expired', 'cancelled'])

export const contract = {
  /** Agent tool: what may I use? */
  mine: kc
    .meta({
      agent: 'own-group',
      tool: {
        name: 'list_accounts',
        instructions:
          'Lists the accounts you may use, per service. To pick one, put its `selector` where the token goes (e.g. `Authorization: Bearer kurumi:google/alice@work.example`); with none, the only or default account is used.',
      },
    })
    .output(z.object({ accounts: z.array(MyAccountSchema) })),

  /**
   * Agent tool and Console/CLI: ask to connect an account for `services` (one vendor) to a group.
   * From an agent: posts a Connect Card into the agent's chat and returns at once; the session is resumed with a
   * system message when a human finishes. Idempotent per (group, vendor, session).
   * From host/human: returns a one-time link minted for that caller (CLI prints it; Console navigates).
   */
  connect: kc
    .meta({
      cli: true,
      agent: 'own-group',
      tool: {
        name: 'connect_account',
        instructions:
          'Call when the user asks to connect a service, or when a request failed with account_not_connected / account_needs_reauth (pass the `service` from the error). A card appears in this chat; you get a message when it is done. Never ask the user for keys or links.',
      },
    })
    .input(z.object({ services: z.array(ServiceIdSchema).min(1), agentGroupId: z.string().optional() }))
    .output(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card_posted'), requestId: z.string() }),
        z.object({ kind: z.literal('link'), requestId: z.string(), url: z.url(), expiresAt: z.date() }),
      ]),
    ),

  list: kc
    .meta({ cli: true })
    .input(z.object({ agentGroupId: z.string().optional() }))
    .output(z.object({ accounts: z.array(AccountSchema) })),

  /** Grants are human decisions: no `agent` meta, so the guard refuses agents (never holds). */
  grant: kc.meta({ cli: true }).input(
    z.object({
      handle: HandleSchema,
      service: ServiceIdSchema,
      agentGroupId: z.string(),
      default: z.boolean().default(false),
    }),
  ),
  revoke: kc.meta({ cli: true }).input(z.object({ handle: HandleSchema, service: ServiceIdSchema, agentGroupId: z.string() })),
  setDefault: kc.meta({ cli: true }).input(z.object({ handle: HandleSchema, service: ServiceIdSchema, agentGroupId: z.string() })),

  /** Key vendors (Anthropic, GitHub PAT). The value is accepted and never returned. */
  addKey: kc
    .meta({ cli: true })
    .input(z.object({ vendor: VendorIdSchema, label: z.string().min(1), value: z.string().min(1), autoGrant: z.boolean().default(false) }))
    .output(z.object({ handle: HandleSchema })),
  remove: kc.meta({ cli: true }).input(z.object({ handle: HandleSchema })),

  setClient: kc
    .meta({ cli: true })
    .input(z.object({ vendor: VendorIdSchema, clientId: z.string(), clientSecret: z.string() })),

  requests: kc
    .meta({ cli: true })
    .input(z.object({ live: z.boolean().default(true) }))
    .output(
      z.object({
        requests: z.array(
          z.object({
            id: z.string(),
            agentGroupId: z.string(),
            vendor: VendorIdSchema,
            services: z.array(ServiceIdSchema),
            state: RequestState,
            expiresAt: z.date(),
          }),
        ),
      }),
    ),
  cancel: kc.meta({ cli: true }).input(z.object({ requestId: z.string() })),
}
