#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import {
  AccountViewSchema,
  AddKeyOutputSchema,
  contract as accountContract,
} from '@kurumi/account/contract'
import { contract as agentContract } from '@kurumi/agent/contract'
import { contract as chatContract, type TerminalEvent } from '@kurumi/chat/contract'
import { hostContract, type Meta } from '@kurumi/rpc/contract'
import { createORPCClient, type ClientLink } from '@orpc/client'
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
  return runCommand(argv, {
    contract: { agent: agentContract, account: accountContract, ...hostContract },
    link,
    stdin: { isTTY: process.stdin.isTTY, chunks: process.stdin },
  })
}

export type Stdin = { isTTY: boolean; chunks: AsyncIterable<Uint8Array> }

type Link = ClientLink<Record<string, never>>

export async function runCommand(
  argv: string[],
  { contract, link, stdin }: { contract: AnyContractRouter; link: Link; stdin: Stdin },
): Promise<number> {
  const router = forward(contract, link, stdin)
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
  link: Link,
  stdin: Stdin,
  path: string[] = [],
): ForwardingRouter {
  const router: ForwardingRouter = {}
  for (const [key, child] of Object.entries(contract)) {
    const childPath = [...path, key]
    if (!isContractProcedure(child)) {
      const children = forward(child, link, stdin, childPath)
      if (Object.keys(children).length > 0) router[key] = children
      continue
    }
    const { inputSchema, outputSchema } = child['~orpc']
    const meta: Meta = child['~orpc'].meta
    if (meta.cli !== true) continue
    const command = childPath
      .map((name) => name.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
      .join(' ')
    const piped = stdinFieldOf(command, inputSchema)
    const render = renderers[childPath.join('.')] ?? json
    router[key] = os
      .meta(meta)
      .input(piped?.cliSchema ?? inputSchema ?? z.object({}))
      .handler(async ({ input }) => {
        const sent = piped
          ? withField(input, piped.field, await readStdinValue(stdin, command, piped))
          : input
        try {
          const output = await link.call(childPath, inputSchema ? sent : undefined, {
            context: {},
          })
          const text = outputSchema === undefined ? '' : render(output)
          if (text !== '') process.stdout.write(`${text}\n`)
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

const json = (output: unknown) => JSON.stringify(output, null, 2)

const renderers: Readonly<Record<string, (output: unknown) => string>> = {
  'account.addKey': (output) => AddKeyOutputSchema.parse(output).handle,
  'account.list': (output) =>
    alignColumns(
      z
        .array(AccountViewSchema)
        .parse(output)
        .map((view) => [
          view.handle,
          view.authMode ?? view.kind,
          view.services.join(','),
          view.autoGrant ? 'auto-grant' : '',
        ]),
    ),
}

function alignColumns(rows: readonly string[][]): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

type StdinField = {
  field: string
  schema: z.core.$ZodType
  maxLength: number
  cliSchema: z.ZodType
}

function stdinFieldOf(command: string, schema: unknown): StdinField | null {
  if (!(schema instanceof z.ZodType)) return null
  const [only, ...more] = stdinMarkers(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
  )
  if (!only) return null
  const refuse = (why: string) => new Error(`kurumi ${command} cannot read stdin: ${why}`)
  const items: readonly z.core.$ZodType[] = schema instanceof z.ZodTuple ? schema.def.items : []
  const options = items.at(-1)
  const field = only.path
    .join('/')
    .match(new RegExp(`^prefixItems/${items.length - 1}/properties/([^/]+)(?:/anyOf/\\d+)*$`))?.[1]
  if (more.length > 0 || field === undefined || !(options instanceof z.ZodObject)) {
    throw refuse('only one field of the trailing options object may be marked stdin')
  }
  if (typeof only.maxLength !== 'number') throw refuse(`${field} needs a maximum length`)
  const { [field]: fieldSchema, ...rest } = options.shape
  if (fieldSchema === undefined) throw refuse(`${field} is not in the options object`)
  const [first, ...others] = [...items.slice(0, -1), z.object(rest)]
  return {
    field,
    schema: fieldSchema,
    maxLength: only.maxLength,
    cliSchema: z.tuple([first, ...others]),
  }
}

function stdinMarkers(
  node: unknown,
  path: string[] = [],
): { path: string[]; maxLength: unknown }[] {
  if (typeof node !== 'object' || node === null) return []
  const here =
    'stdin' in node && node.stdin === true
      ? [{ path, maxLength: 'maxLength' in node ? node.maxLength : undefined }]
      : []
  return [
    ...here,
    ...Object.entries(node).flatMap(([key, child]) => stdinMarkers(child, [...path, key])),
  ]
}

function withField(input: unknown, field: string, value: string): unknown[] {
  const last: unknown = Array.isArray(input) ? input.at(-1) : undefined
  if (!Array.isArray(input) || typeof last !== 'object' || last === null) {
    throw new Error('expected a tuple input that ends in options')
  }
  return [...input.slice(0, -1), { ...last, [field]: value }]
}

const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3
const TRAILING_CRLF_BYTES = 2

async function readStdinValue(
  stdin: Stdin,
  command: string,
  { field, schema, maxLength }: StdinField,
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error(
      `BAD_REQUEST: ${field} is read from stdin, so pipe it in, for example: pbpaste | kurumi ${command} ...`,
    )
  }
  const byteLimit = maxLength * MAX_UTF8_BYTES_PER_UTF16_UNIT + TRAILING_CRLF_BYTES
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of stdin.chunks) {
    bytes += chunk.byteLength
    if (bytes > byteLimit) {
      throw new Error(
        `BAD_REQUEST: stdin is longer than the ${maxLength} characters ${field} may hold`,
      )
    }
    chunks.push(chunk)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    throw new Error(`BAD_REQUEST: stdin is not valid UTF-8, so it holds no ${field}`, {
      cause: error,
    })
  }
  const value = text.replace(/\r?\n$/, '')
  if (value === '') throw new Error(`BAD_REQUEST: stdin was empty, so there is no ${field}`)
  const parsed = z.safeParse(schema, value)
  if (!parsed.success) {
    throw new Error(`BAD_REQUEST: ${parsed.error.issues.map(({ message }) => message).join('; ')}`)
  }
  return value
}

function writeLine(stream: NodeJS.WriteStream, args: unknown[]): void {
  const text = args.map(String).join(' ')
  stream.write(text.endsWith('\n') ? text : `${text}\n`)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
