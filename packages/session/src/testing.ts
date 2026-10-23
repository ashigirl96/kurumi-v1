import type { ContainerDriver, ContainerSpec } from './server.ts'

export function createFakeDriver() {
  const runs: ContainerSpec[] = []
  const living = new Set<string>()
  const listeners = new Set<(containerId: string, code: number) => void>()
  const driver: ContainerDriver & {
    runs: ContainerSpec[]
    result: Awaited<ReturnType<ContainerDriver['run']>>
    beforeRun(): Promise<void>
  } = {
    runs,
    result: { ok: true },
    beforeRun: async (): Promise<void> => {},
    async run(spec: ContainerSpec) {
      runs.push(structuredClone(spec))
      await driver.beforeRun()
      if (driver.result.ok) living.add(spec.containerId)
      return driver.result
    },
    async kill(containerId: string, _graceMs: number) {
      living.delete(containerId)
      for (const listener of listeners) listener(containerId, 0)
    },
    async list() {
      return [...living].map((containerId) => ({ containerId, running: true }))
    },
    onExit(listener: (containerId: string, code: number) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return driver
}
