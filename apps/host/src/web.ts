import type { AccountLedger } from '@kurumi/account/server'

export function startWeb(
  bind: { host: string; port: number },
  account: Pick<AccountLedger, 'connections'>,
) {
  if (bind.host !== '127.0.0.1') throw new Error('web listener must bind 127.0.0.1')
  // Containers reach this port through host.docker.internal, so every route must check a token or OAuth state; loopback only keeps OAuth at the Mac.
  return Bun.serve({
    hostname: bind.host,
    port: bind.port,
    fetch(request) {
      const url = new URL(request.url)
      const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
      if (request.method === 'GET' && url.pathname.startsWith('/connect/')) {
        const result = account.connections.openLink(url.pathname.slice('/connect/'.length))
        if (result.kind === 'authorize')
          return new Response(null, {
            status: 302,
            headers: { ...headers, location: result.url.href },
          })
        return new Response(
          'This link is used or expired. Press the button or run account connect again.',
          {
            status: 410,
            headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
          },
        )
      }
      return new Response('Not found', { status: 404, headers })
    },
    error() {
      return new Response('Unable to open the connection. Run account connect again.', {
        status: 500,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    },
  })
}
