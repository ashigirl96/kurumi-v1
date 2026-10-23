#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'

import { contract as agentContract } from '@kurumi/agent/contract'
import { hostContract, type Meta } from '@kurumi/rpc/contract'
import { RPCLink } from '@orpc/client/fetch'
import { isContractProcedure, type AnyContractRouter } from '@orpc/contract'
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
  const router = forward({ agent: agentContract, ...hostContract }, link)
  const cli = createCli({ router, name: 'kurumi', description: 'Manage the Kurumi host' })
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
