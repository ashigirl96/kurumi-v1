import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { z } from 'zod'

const port = z.coerce.number().int().min(1).max(65535)
const environment = z.object({
  KURUMI_HOME: z.string().min(1).default(join(homedir(), '.kurumi')),
  KURUMI_AGENT_PORT: port.default(4000),
  KURUMI_WEB_PORT: port.default(4001),
})

export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = environment.parse(env)
  return {
    home: resolve(parsed.KURUMI_HOME),
    agentPort: { host: '127.0.0.1', port: parsed.KURUMI_AGENT_PORT },
    web: { host: '127.0.0.1', port: parsed.KURUMI_WEB_PORT },
  }
}

export type HostConfig = ReturnType<typeof loadConfig>
