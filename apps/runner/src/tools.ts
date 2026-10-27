import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { contract as access } from '@kurumi/access/contract'
import { contract as account } from '@kurumi/account/contract'
import { contract as agent } from '@kurumi/agent/contract'
import { contract as approval } from '@kurumi/approval/contract'
import { contract as chat } from '@kurumi/chat/contract'
import { contract as gateway } from '@kurumi/gateway/contract'
import { hostContract, type Meta } from '@kurumi/rpc/contract'
import { contract as session } from '@kurumi/session/contract'
import type { ClientLink } from '@orpc/client'
import { isContractProcedure, type AnyContractRouter } from '@orpc/contract'
import { z } from 'zod'

export const runnerContract = {
  access,
  account,
  agent,
  approval,
  chat,
  gateway,
  session,
  ...hostContract,
}

export function toolsOf(
  contract: AnyContractRouter,
  link: ClientLink<Record<string, never>>,
  signal: AbortSignal,
): ReturnType<typeof tool>[] {
  const names = new Set<string>()
  function walk(router: AnyContractRouter, path: string[]): ReturnType<typeof tool>[] {
    return Object.entries(router).flatMap(([key, child]) => {
      const childPath = [...path, key]
      if (!isContractProcedure(child)) return walk(child, childPath)
      const { inputSchema } = child['~orpc']
      const meta: Meta = child['~orpc'].meta
      if (!meta.tool) return []
      if (!meta.agent)
        throw new Error(`${childPath.join('.')} has tool metadata without agent access`)
      if (inputSchema !== undefined && !(inputSchema instanceof z.ZodObject)) {
        throw new Error(`${childPath.join('.')} needs an object input schema for a tool`)
      }
      if (names.has(meta.tool.name)) throw new Error(`Duplicate tool name: ${meta.tool.name}`)
      names.add(meta.tool.name)
      return [
        tool(
          meta.tool.name,
          meta.tool.instructions,
          inputSchema?.shape ?? {},
          async (input, extra) => {
            const output = await link.call(childPath, inputSchema ? input : undefined, {
              context: {},
              signal:
                typeof extra === 'object' &&
                extra !== null &&
                'signal' in extra &&
                extra.signal instanceof AbortSignal
                  ? extra.signal
                  : signal,
            })
            return { content: [{ type: 'text', text: JSON.stringify(output) }] }
          },
        ),
      ]
    })
  }
  return walk(contract, [])
}

export function createKurumiServer(link: ClientLink<Record<string, never>>, signal: AbortSignal) {
  return createSdkMcpServer({ name: 'kurumi', tools: toolsOf(runnerContract, link, signal) })
}
