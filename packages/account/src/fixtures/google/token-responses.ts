const base64urlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const unsignedIdToken = (claims: Record<string, unknown>): string =>
  `${base64urlJson({ alg: 'none', typ: 'JWT' })}.${base64urlJson(claims)}.`

const idToken = unsignedIdToken({
  iss: 'https://accounts.google.com',
  azp: 'example-client-id.apps.googleusercontent.com',
  aud: 'example-client-id.apps.googleusercontent.com',
  sub: '100000000000000000001',
  email: 'alice@example.com',
  email_verified: true,
  at_hash: 'example-at-hash',
  iat: 1700000000,
  exp: 1700003600,
})

const fullScope =
  'openid https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email'
const gmailOnlyScope =
  'openid https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email'

export const tokenFull = {
  access_token: 'example-access-token-full',
  expires_in: 3599,
  refresh_token: 'example-refresh-token-full',
  scope: fullScope,
  token_type: 'Bearer',
  id_token: idToken,
}

export const tokenGmailOnly = {
  access_token: 'example-access-token-gmail',
  expires_in: 3599,
  refresh_token: 'example-refresh-token-gmail',
  scope: gmailOnlyScope,
  token_type: 'Bearer',
  id_token: idToken,
}

export const refreshFull = {
  access_token: 'example-access-token-refreshed',
  expires_in: 3599,
  scope: fullScope,
  token_type: 'Bearer',
  id_token: idToken,
}
