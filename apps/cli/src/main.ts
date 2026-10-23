#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { contract as agentContract } from '@kurumi/agent/contract'
import { contract as chatContract, type TerminalEvent } from '@kurumi/chat/contract'
import { hostContract, type Meta } from '@kurumi/rpc/contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import {
  isContractProcedure,
  type AnyContractRouter,
  type ContractRouterClient,
} from '@orpc/contract'
import { ORPCError, os, type AnyProcedure } from '@orpc/server'
import { CliValidationError, createCli, FailedToExitError } from 'trpc-cli'
import { z } from 'zod'

type ForwardingRouter = { [key: string]: ForwardingRouter | AnyProcedure }

export async function main(argv: string[]): Promise<number> {
  const home = process.env.KURUMI_HOME ?? join(homedir(), '.kurumi')
  const socket = join(home, 'kurumi.sock')
  const link = new RPCLink<Record<string, never>>({
    url: 'http://localhost/rpc',
    async fetch(request, init) {
      const signal =
        new URL(request.url).pathname === '/rpc/status'
          ? AbortSignal.any([request.signal, AbortSignal.timeout(750)])
          : request.signal
      try {
        return await fetch(request, {
          ...init,
          unix: socket,
          signal,
        })
      } catch (error) {
        throw new Error(`HOST_NOT_RUNNING: host is not running or answering at ${socket}`, {
          cause: error,
        })
      }
    },
  })
  if (argv[0] === 'chat') return chat(argv.slice(1), link)
  const router = forward({ agent: agentContract, ...hostContract }, link)
  const cli = createCli({
    router,
    name: 'kurumi',
    description: 'Manage the Kurumi host. Use kurumi chat <agent> to send stdin lines.',
  })
  try {
    await cli.run({
      argv,
      prompts: false,
      logger: {
        info: (...args) => writeLine(process.stdout, args),
        error: (...args) => writeLine(process.stderr, args),
      },
      formatError(error) {
        if (error instanceof CliValidationError) {
          const [reason = 'Invalid input'] = error.message.split('\n\n')
          return `BAD_REQUEST: ${reason.replaceAll('\n', ' ').trim()}`
        }
        return error instanceof Error ? error.message : String(error)
      },
      process: {
        exit(code) {
          throw new FailedToExitError('kurumi finished', { exitCode: code, cause: undefined })
        },
      },
    })
    return 0
  } catch (error) {
    if (error instanceof FailedToExitError) return error.exitCode
    throw error
  }
}

async function chat(argv: string[], link: RPCLink<Record<string, never>>): Promise<number> {
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    process.stderr.write('Usage: kurumi chat <agent>\n')
    return argv[0] === '--help' || argv[0] === '-h' ? 0 : 1
  }
  const client: ContractRouterClient<{ agent: typeof agentContract; chat: typeof chatContract }> =
    createORPCClient(link)
  const controller = new AbortController()
  const interrupt = () => {
    controller.abort()
    process.stdin.destroy()
  }
  process.once('SIGINT', interrupt)
  let replies: AsyncIterator<TerminalEvent> | undefined
  let pumping: Promise<void> | undefined
  let replyError: unknown
  try {
    const agents = await client.agent.list(undefined, { signal: controller.signal })
    const matches = agents.filter((agent) => agent.id === argv[0] || agent.name === argv[0])
    const [agent] = matches
    if (!agent) throw new Error(`agent not found: ${argv[0]}`)
    if (matches.length !== 1) throw new Error(`ambiguous agent: ${argv[0]}`)
    const send = async (text: string) => {
      const events = await client.chat.terminal(
        { agentGroupId: agent.id, text, follow: replies === undefined },
        { signal: controller.signal },
      )
      const receipt = await events.next()
      if (receipt.done || receipt.value.kind !== 'queued') {
        throw new Error('host closed chat before acknowledging the line')
      }
      process.stdout.write(`queued (session ${receipt.value.sessionId})\n`)
      if (replies) {
        await events.return?.()
      } else {
        replies = events
        pumping = (async () => {
          for await (const event of events) {
            if (event.kind === 'reply') process.stdout.write(`${event.text}\n`)
          }
        })().catch((error: unknown) => {
          if (!controller.signal.aborted) {
            replyError = error
            interrupt()
          }
        })
      }
    }
    const decoder = new StringDecoder('utf8')
    let pending = ''
    for await (const chunk of process.stdin) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        await send(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.end()
    if (pending.length > 0 && !controller.signal.aborted) await send(pending)
    if (replyError) throw replyError
    return 0
  } catch (error) {
    if (controller.signal.aborted && !replyError) return 0
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    controller.abort()
    await pumping
    await replies?.return?.()
    process.removeListener('SIGINT', interrupt)
  }
}

function forward(
  contract: AnyContractRouter,
  link: RPCLink<Record<string, never>>,
  path: string[] = [],
): ForwardingRouter {
  const router: ForwardingRouter = {}
  for (const [key, child] of Object.entries(contract)) {
    const childPath = [...path, key]
    if (!isContractProcedure(child)) {
      const children = forward(child, link, childPath)
      if (Object.keys(children).length > 0) router[key] = children
      continue
    }
    const { inputSchema } = child['~orpc']
    const meta: Meta = child['~orpc'].meta
    if (meta.cli !== true) continue
    router[key] = os
      .meta(meta)
      .input(inputSchema ?? z.object({}))
      .handler(async ({ input }) => {
        try {
          const output = await link.call(childPath, inputSchema ? input : undefined, {
            context: {},
          })
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } catch (error) {
          if (error instanceof ORPCError) {
            throw new Error(`${error.code}: ${error.message}`, { cause: error })
          }
          throw error
        }
      })
  }
  return router
}

function writeLine(stream: NodeJS.WriteStream, args: unknown[]): void {
  const text = args.map(String).join(' ')
  stream.write(text.endsWith('\n') ? text : `${text}\n`)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
