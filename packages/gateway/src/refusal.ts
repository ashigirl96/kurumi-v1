import { STATUS_CODES } from 'node:http'

import type { CredentialRefusal, ServiceId } from '@kurumi/account/server'

export type HoldRefusal =
  | { code: 'approval_pending'; service: ServiceId; approvalId: string }
  | { code: 'approval_denied'; service: ServiceId; approvalId: string }
  | { code: 'body_too_large'; service: ServiceId; limit: number }
  | { code: 'body_timeout'; service: ServiceId; limitMs: number }
  | { code: 'approval_limit'; service: ServiceId; waiting: 'undecided'; limit: number }
  | {
      code: 'approval_limit'
      service: ServiceId
      waiting: 'in_flight'
      scope: 'agent_group' | 'host'
      limit: number
    }

export type GatewayRefusal =
  | CredentialRefusal
  | { code: 'upstream_not_public'; host: string; reason: string }
  | { code: 'port_not_allowed'; host: string; port: number }
  | HoldRefusal

export const REFUSAL_STATUS = {
  account_not_connected: 403,
  account_ambiguous: 409,
  account_not_granted: 403,
  account_needs_reauth: 403,
  selector_unreadable: 400,
  duplicate_slot: 400,
  method_not_allowed: 405,
  upstream_not_public: 403,
  port_not_allowed: 403,
  approval_pending: 403,
  approval_denied: 403,
  body_too_large: 413,
  body_timeout: 408,
  approval_limit: 429,
} as const satisfies Record<GatewayRefusal['code'], number>

const askToAdd = 'ask the owner to add one with kurumi account add-key and grant it'

export function nextStep(refusal: GatewayRefusal): string {
  switch (refusal.code) {
    case 'account_not_connected':
      return `no account is granted ${refusal.service} for this agent group; ${askToAdd}`
    case 'account_ambiguous':
      return `name one of ${refusal.granted.join(', ')}: put kurumi:<handle> where the token goes, or ask the owner to set a default`
    case 'account_not_granted':
      return refusal.granted.length > 0
        ? `${refusal.named} is not granted ${refusal.service} for this agent group; put kurumi:<handle> for one of ${refusal.granted.join(', ')} where the token goes`
        : `${refusal.named} is not granted ${refusal.service} for this agent group, and no account is; ${askToAdd}`
    case 'account_needs_reauth':
      return `ask the owner to add ${refusal.handle} again`
    case 'selector_unreadable':
      return refusal.accepted.length > 0
        ? `kurumi cannot read the account named where the token goes; put one of ${refusal.accepted.join(', ')} there`
        : `kurumi cannot read the account named where the token goes, and no account is granted ${refusal.service} for this agent group; ${askToAdd}`
    case 'duplicate_slot':
      return `send the ${refusal.header} header once`
    case 'method_not_allowed':
      return `send the request as one of ${refusal.allowed.join(', ')}; kurumi adds no credential to ${refusal.method}`
    case 'port_not_allowed':
      return `connect to ${refusal.host} on port 443; kurumi serves it on no other port`
    case 'upstream_not_public':
      return `ask the owner to check the DNS answer for ${refusal.host} on the kurumi host; it resolves to a ${refusal.reason} address, and kurumi forwards only to public addresses`
    case 'approval_pending':
      return `a person has not decided ${refusal.approvalId} yet; do not send this request again now. kurumi messages this session when it is decided, and after an approval the same request with the same body passes once within 10 minutes`
    case 'approval_denied':
      return `a person denied ${refusal.approvalId}; do not send this request again unless the user asks for it`
    case 'body_too_large':
      return `a rule holds this request for a person to read, and kurumi holds at most ${refusal.limit} bytes; send a smaller body`
    case 'body_timeout':
      return `a rule holds this request for a person to read, and kurumi waits at most ${refusal.limitMs / 1000} s for its body; send the whole body at once`
    case 'approval_limit':
      switch (refusal.waiting) {
        case 'undecided':
          return `${refusal.limit} requests of this agent group already wait for a person; ask the user to decide them with kurumi approval list`
        case 'in_flight':
          return `${refusal.limit} held requests ${refusal.scope === 'host' ? 'already wait on this host' : 'of this agent group already wait'}; send this one again when one of them ends`
        default: {
          const unknown: never = refusal
          return unknown
        }
      }
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
      ...(refusal.code === 'method_not_allowed' && { allow: refusal.allowed.join(', ') }),
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
