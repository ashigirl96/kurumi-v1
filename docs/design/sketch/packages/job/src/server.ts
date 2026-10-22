// @kurumi/job — surface only. Copied from monica's Job Ledger, minus user Jobs: kurumi has no shell Jobs
// (Scheduled Tasks are agent work, owned by schedule). Domains hand `systemJobs(ledger)` to this; none owns a timer.
export type SystemJob = { name: string; every: number; run: () => Promise<void> }

export type JobLedger = { start(): void; stop(): void }

/** One setInterval(10 s) tick; a job whose previous run is still going is skipped, not stacked. */
export function createJobLedger(deps: { systemJobs: readonly SystemJob[] }): JobLedger {
  throw new Error('not implemented')
}
