import { z } from 'zod'

export const accountMaterial = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('key'), key: z.string() }),
  z.object({
    kind: z.literal('oauth'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
    grantedScopes: z.array(z.string()),
  }),
])

export type AccountMaterial = z.infer<typeof accountMaterial>
