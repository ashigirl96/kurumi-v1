import { STATUS_CODES } from 'node:http'

import type { CredentialRefusal } from '@kurumi/account/server'

export type GatewayRefusal =
  | CredentialRefusal
  | { code: 'upstream_not_public'; host: string; reason: string }

export const REFUSAL_STATUS = {
  account_not_connected: 404,
  account_ambiguous: 409,
  account_not_granted: 403,
  account_needs_reauth: 403,
  duplicate_slot: 400,
  upstream_not_public: 403,
} as const satisfies Record<GatewayRefusal['code'], number>

export function nextStep(refusal: GatewayRefusal): string {
  switch (refusal.code) {
    case 'account_not_connected':
      return `no account is granted ${refusal.service} for this agent group; ask the owner to add one with kurumi account add-key and grant it`
    case 'account_ambiguous':
      return `name one of ${refusal.granted.join(', ')}: put kurumi:<handle> where the token goes, or ask the owner to set a default`
    case 'account_not_granted': {
      const granted = refusal.granted.length > 0 ? refusal.granted.join(', ') : 'none'
      return `${refusal.named} is not granted ${refusal.service} for this agent group; put kurumi:<handle> for one of ${granted} where the token goes`
    }
    case 'account_needs_reauth':
      return `ask the owner to add ${refusal.handle} again`
    case 'duplicate_slot':
      return `send the ${refusal.header} header once`
    case 'upstream_not_public':
      return `ask the owner to check the DNS answer for ${refusal.host} on the kurumi host; it resolves to a ${refusal.reason} address, and kurumi forwards only to public addresses`
    default: {
      const unknown: never = refusal
      return unknown
    }
  }
}

export function refusalResponse(refusal: GatewayRefusal): {
  status: number
  headers: Record<string, string>
  body: string
} {
  const { code, ...fields } = refusal
  const body = JSON.stringify({ error: code, ...fields, next: nextStep(refusal) })
  return {
    status: REFUSAL_STATUS[code],
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      // The Anthropic SDK retries a 409 unless told not to.
      'x-should-retry': 'false',
      'x-kurumi-gateway': code,
    },
    body,
  }
}

export function refusalHttp(refusal: GatewayRefusal): string {
  const { status, headers, body } = refusalResponse(refusal)
  const lines = Object.entries({ ...headers, connection: 'close' }).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  )
  return `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines.join('')}\r\n${body}`
}
