import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type ListedContainer = {
  dockerId: string
  name: string
  role: 'agent' | 'probe' | null
  sessionId: string | null
  containerId: string | null
  revision: string | null
  state: string
}
export async function endForeignWaits(names: ReadonlySet<string>): Promise<void> {
  const { stdout } = await promisify(execFile)('ps', ['-e', '-o', 'pid=,ppid=,command='], {
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }))
  for (const line of stdout.split('\n')) {
    const [, pid, ppid, command = ''] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? []
    const waited = /(?:^|[\s/])docker wait (\S+)\s*$/.exec(command)?.[1]
    if (!waited || !names.has(waited) || Number(ppid) === process.pid) continue
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
}

// Each field goes through json so that a label value cannot end its line, and .Labels is left out
// because it joins labels with commas that a value can also contain.
export const listingFormat =
  '[{{json .ID}},{{json .Names}},{{json .State}},{{json (.Label "kurumi.role")}},{{json (.Label "kurumi.session")}},{{json (.Label "kurumi.container")}},{{json (.Label "kurumi.revision")}}]'

export function parseListing(line: string): ListedContainer | null {
  let fields: unknown
  try {
    fields = JSON.parse(line)
  } catch {
    return null
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 7 ||
    !fields.every((field): field is string => typeof field === 'string')
  )
    return null
  const [dockerId = '', names = '', state = '', role, sessionId, containerId, revision] = fields
  // With --no-trunc, .Names also lists the "<linker>/<alias>" names of legacy links.
  const [name, ...others] = names.split(',').filter((entry) => !entry.includes('/'))
  if (!/^[0-9a-f]{64}$/.test(dockerId) || !name || others.length > 0) return null
  return {
    dockerId,
    name,
    role: role === 'agent' || role === 'probe' ? role : null,
    sessionId: sessionId || null,
    containerId: containerId || null,
    revision: revision || null,
    state,
  }
}
