// @kurumi/schedule/server — Scheduled Task series (one-shot / cron), script gate, run log, backoff, pause.
// Deviation from monica ADR-0016 (late Jobs are skipped): a run that came due while the host was down runs once
// on the next tick. Only the latest missed occurrence runs (no burst), then next_at moves past now.
import type { AgentLedger } from '@kurumi/agent/server'
import type { SystemJob } from '@kurumi/job/server'
import type { Db, KurumiContext } from '@kurumi/rpc/server'
import type { SessionLedger } from '@kurumi/session/server'
import { implement } from '@orpc/server'

import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'

export type ScheduleLedger = {
  start(): void
  stop(): void
  events: { subscribe(listener: (e: { type: 'change' }) => void): () => void }
  /** Called by session when a task run's turn ends: success resets failures; script failure backs off 2→60 min, 8 → pause. */
  recordRun(seriesId: string, outcome: { ok: true } | { ok: false; scriptFailed: boolean }): void
}

export function createScheduleLedger(deps: {
  db: Db
  sessionLedger: Pick<SessionLedger, 'enqueueTask'>
  agentLedger: AgentLedger
}): ScheduleLedger {
  throw new Error('not implemented')
}

const os = implement(contract).$context<KurumiContext & { scheduleLedger: ScheduleLedger }>()
const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const router = os.router({
  list: os.list.handler(notImplemented),
  show: os.show.handler(notImplemented),
  create: os.create.handler(notImplemented),
  update: os.update.handler(notImplemented),
  cancel: os.cancel.handler(notImplemented),
  pause: os.pause.handler(notImplemented),
  resume: os.resume.handler(notImplemented),
  run: os.run.handler(notImplemented),
  appendLog: os.appendLog.handler(notImplemented),
})

/** 'schedule.due' every 30 s: tx { for each active series with next_at ≤ now: sessionLedger.enqueueTask(tx, …); advance next_at }. */
export function systemJobs(_scheduleLedger: ScheduleLedger): SystemJob[] {
  return [{ name: 'schedule.due', every: 30_000, run: async () => notImplemented() }]
}
