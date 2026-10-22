// @kurumi/agent/server — Agent Group, container config, Workspace, persona, CLAUDE.md composition,
// container skills, templates. Lowest domain: imports no other domain.
import type { SystemJob } from '@kurumi/job/server'
import type { Db, KurumiContext, Tx } from '@kurumi/rpc/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'
export type { AgentGroupId } from './contract.ts'

export type AgentLedger = {
  start(): void
  stop(): void
  /** `created` / `removed` / `change`; account auto-grants and session teardown subscribe. */
  events: {
    subscribe(listener: (e: { type: 'created' | 'removed' | 'change'; agentGroupId: string }) => void): () => void
  }
  cliScopeOf(agentGroupId: string): 'disabled' | 'group' | 'global'
  /** Sync config write for self-mod (called by session inside its transaction). */
  updateConfig(tx: Tx, agentGroupId: string, patch: { packages?: { apt: string[]; npm: string[] } }): void
  /**
   * Fs side effects after commit, before spawn: scaffold groups/<folder>/ (memory/, conversations/, tasks/),
   * regenerate CLAUDE.md (persona → base contract → tool instructions derived from the contract's `meta.tool`
   * → selected skills → MCP server instructions; size-capped), write container.json, link skills.
   */
  prepareWorkspace(agentGroupId: string): Promise<{ folder: string; claudeMd: string; skillsDir: string }>
  /** Validates extra mounts against ~/.config/kurumi/mount-allowlist.json (blocked patterns built in). */
  mountsFor(agentGroupId: string): { hostPath: string; containerPath: string; readonly: boolean }[]
  appendTaskLog(agentGroupId: string, seriesId: string, text: string): Promise<void>
}

export function createAgentLedger(deps: { db: Db; home: string; templatesDir: string }): AgentLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { agentLedger: AgentLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  list: os.list.handler(notImplemented),
  show: os.show.handler(notImplemented),
  create: os.create.handler(notImplemented),
  update: os.update.handler(notImplemented),
  remove: os.remove.handler(notImplemented),
  config: {
    get: os.config.get.handler(notImplemented),
    update: os.config.update.handler(notImplemented),
    addMount: os.config.addMount.handler(notImplemented),
    removeMount: os.config.removeMount.handler(notImplemented),
  },
  templates: { list: os.templates.list.handler(notImplemented) },
})

export function systemJobs(_agentLedger: AgentLedger): SystemJob[] {
  return []
}
