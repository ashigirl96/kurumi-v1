// apps/cli — `kurumi`. One binary for two places, like monica's CLI:
//   on the host machine : KURUMI_HOME/kurumi.sock (0600) → caller = host. No token: the socket's mode is the auth.
//   inside a container  : KURUMI_URL + KURUMI_TOKEN → caller = agent; the guard applies CLI Scope and holds.
// Commands are the contract's `meta.cli` leaves (trpc-cli forwarding router, monica's apps/cli/src/forward.ts).
// Exit codes: 0 ok, 1 failure (stderr line 1 = `CODE: message`, e.g. `APPROVAL_PENDING: apr-…`), 2 host absent.
// Never opens kurumi.db (monica ADR-0003).
//
// Examples:
//   kurumi account add-key anthropic --label main --value sk-ant-… --auto-grant
//   kurumi account set-client google --client-id … --client-secret …
//   kurumi account connect --services gmail,google-calendar --agent-group-id ag-work   → prints a one-time link
//   kurumi account list --agent-group-id ag-work
//   kurumi account grant google/bob@home.example --service gmail --agent-group-id ag-home --default
//   kurumi gateway rules add --priority 10 --target '{"account":"google/alice@work.example"}' --method POST \
//        --path '/gmail/v1/users/me/messages/send' --effect '{"kind":"approve"}'
//   kurumi chat ag-work                                             → terminal chat (hand-written command)
export async function main(argv: string[]): Promise<number> {
  throw new Error('not implemented')
}
