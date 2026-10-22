// apps/runner — the built-in MCP server (stdio) the Agent SDK talks to.
// The tool list is DERIVED: every procedure in the composed contract whose meta has `tool` becomes an MCP tool
// whose input schema is the procedure's zod input and whose call is the oRPC call. There is no hand-written
// tool table to keep in sync, and no second server (the in-chat connect tool is `account.connect`).
import type { Meta } from '@kurumi/rpc/contract'

export type DerivedTool = {
  name: string
  instructions: string
  path: readonly string[] // e.g. ['account', 'connect']
  inputJsonSchema: unknown
}

/** Walks the contract tree; collects `meta.tool`. Duplicate tool names fail at runner start (and in a test). */
export function deriveTools(contract: object): DerivedTool[] {
  // TODO walk { [domain]: { [proc]: ContractProcedure | nested } }, read `~orpc.meta as Meta`
  throw new Error('not implemented')
}

/** Host side uses the same walk to put each tool's `instructions` into CLAUDE.md (agent.prepareWorkspace). */
export type { Meta }
