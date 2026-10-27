#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { contract as accessContract } from '@kurumi/access/contract'
import {
  AccountViewSchema,
  AddKeyOutputSchema,
  ConnectOutputSchema,
  contract as accountContract,
} from '@kurumi/account/contract'
import { contract as agentContract } from '@kurumi/agent/contract'
import { contract as approvalContract } from '@kurumi/approval/contract'
import { contract as chatContract, type TerminalEvent } from '@kurumi/chat/contract'
import {
  EgressLogRowSchema,
  contract as gatewayContract,
  GatewayStatusSchema,
} from '@kurumi/gateway/contract'
import { hostContract, type Meta } from '@kurumi/rpc/contract'
import { createORPCClient, type ClientLink } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import {
  isContractProcedure,
  type AnyContractRouter,
  type ContractRouterClient,
} from '@orpc/contract'
import { ORPCError, os, type AnyProcedure } from '@orpc/server'
import { CliValidationError, createCli, FailedToExitError, kebabCase } from 'trpc-cli'
import { z } from 'zod'

type ForwardingRouter = { [key: string]: ForwardingRouter | AnyProcedure }

export const cliContract = {
  agent: agentContract,
  access: accessContract,
  approval: approvalContract,
  account: accountContract,
  gateway: gatewayContract,
  ...hostContract,
}

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
    contract: cliContract,
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
  let router: ForwardingRouter
  try {
    router = forward(contract, link, stdin, argv)
  } catch (error) {
    if (!(error instanceof StdinRouteError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 1
  }
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
  argv: string[],
  path: string[] = [],
): ForwardingRouter {
  const router: ForwardingRouter = {}
  for (const [key, child] of Object.entries(contract)) {
    const childPath = [...path, key]
    if (!isContractProcedure(child)) {
      const children = forward(child, link, stdin, argv, childPath)
      if (Object.keys(children).length > 0) router[key] = children
      continue
    }
    const { inputSchema, outputSchema } = child['~orpc']
    const meta: Meta = child['~orpc'].meta
    if (meta.cli !== true) continue
    const names = childPath.map(kebabCase)
    const command = names.join(' ')
    // trpc-cli converts every input to JSON Schema, yet help shows a command's input only in its own group's listing.
    const shown = names.slice(0, -1).every((name) => argv.includes(name))
    const piped =
      names.every((name) => argv.includes(name)) || (shown && names.length > 1)
        ? stdinFieldOf(command, inputSchema)
        : null
    const render = renderers[childPath.join('.')] ?? json
    router[key] = os
      .meta(meta)
      .input((shown ? (piped?.cliSchema ?? inputSchema) : undefined) ?? z.object({}))
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
  'account.connect': (output) => ConnectOutputSchema.parse(output).url,
  'account.addKey': (output) => AddKeyOutputSchema.parse(output).handle,
  'account.list': (output) =>
    alignColumns(
      z
        .array(AccountViewSchema)
        .parse(output)
        .map((view) => [
          view.handle,
          view.kind,
          view.services.join(','),
          view.autoGrant ? 'auto-grant' : '',
        ]),
    ),
  'gateway.status': (output) => {
    const status = GatewayStatusSchema.parse(output)
    return alignColumns([
      ['admission', [status.admission, status.detail ?? ''].join(' ').trim()],
      ['agent port', `${status.agentPort.host}:${status.agentPort.port}`],
      ['ca sha256', status.caFingerprint],
    ])
  },
  'gateway.log': (output) =>
    alignColumns(
      z
        .array(EgressLogRowSchema)
        .parse(output)
        .map((row) => [
          row.at.toISOString(),
          row.account ?? '-',
          row.service ?? '-',
          row.decision,
          String(row.status ?? '-'),
          `${row.durationMs}ms`,
          row.method,
          row.path.startsWith('/') ? `${row.host}${row.path}` : row.path,
          row.agentGroupId,
          row.refusal ?? '',
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

class StdinRouteError extends Error {}

function stdinFieldOf(command: string, schema: unknown): StdinField | null {
  if (!(schema instanceof z.core.$ZodType)) return null
  const { markers, cyclic } = stdinMarkers(schema)
  const [marker, ...others] = markers
  if (!marker) return null
  const refuse = (why: string) => new StdinRouteError(`kurumi ${command} cannot read stdin: ${why}`)
  if (others.length > 0) {
    const all = markers.map(({ at }) => pathOf(at)).join(' and ')
    throw refuse(`${all} are each marked stdin, but only one field can be`)
  }
  const where = pathOf(marker.at)
  const items: readonly z.core.$ZodType[] =
    schema instanceof z.core.$ZodTuple ? schema._zod.def.items : []
  const options = items.at(-1)
  const [owner, property] = marker.at
  if (
    !(options instanceof z.core.$ZodObject) ||
    marker.at.length !== 2 ||
    owner?.kind !== 'index' ||
    owner.index !== items.length - 1 ||
    property?.kind !== 'property'
  ) {
    throw refuse(`${where} is marked stdin, but only a field of the trailing options object can be`)
  }
  const { maxLength } = z.toJSONSchema(marker.schema, {
    io: 'input',
    unrepresentable: 'any',
    metadata: z.registry(),
  })
  if (typeof maxLength !== 'number') throw refuse(`${where} needs a maximum length`)
  if (cyclic) throw refuse(`${where} is marked stdin, but a recursive schema reaches it again`)
  const rest = Object.entries(options._zod.def.shape).filter(([name]) => name !== property.name)
  const [first, ...more] = [...items.slice(0, -1), z.object(Object.fromEntries(rest))]
  return {
    field: property.name,
    schema: property.schema,
    maxLength,
    cliSchema: z.tuple([first, ...more]),
  }
}

type Step =
  | { kind: 'index'; index: number }
  | { kind: 'property'; name: string; schema: z.core.$ZodType }
  | { kind: 'keyword'; name: string }

type Marker = { at: readonly Step[]; schema: z.core.$ZodType }

const pathOf = (at: readonly Step[]): string =>
  `input${at
    .map((step) =>
      step.kind === 'index'
        ? `[${step.index}]`
        : step.kind === 'property'
          ? `.${step.name}`
          : `<${step.name}>`,
    )
    .join('')}`

const SAME_VALUE_DEF_KEYS = new Set(['innerType', 'in', 'out', 'options', 'left', 'right'])

function stdinMarkers(root: z.core.$ZodType): { markers: Marker[]; cyclic: boolean } {
  const memo = new Map<z.core.$ZodType, { markers: Marker[]; low: number }>()
  const open = new Map<z.core.$ZodType, number>()
  const unfinished: z.core.$ZodType[] = []
  let entered = 0
  let cyclic = false
  // `low` is the first-entered node of an unfinished cycle that this node's subtree reached.
  const walk = (schema: z.core.$ZodType): { markers: Marker[]; low: number } => {
    const cached = memo.get(schema)
    if (cached) return cached
    const order = open.get(schema)
    if (order !== undefined) return { markers: [], low: order }
    const self = entered++
    open.set(schema, self)
    const start = unfinished.length
    const children = childSchemas(schema).map(([step, child]) => ({ step, ...walk(child) }))
    open.delete(schema)
    const here: Marker[] = z.globalRegistry.get(schema)?.stdin === true ? [{ at: [], schema }] : []
    const markers = [
      ...new Set([
        ...here,
        ...children.flatMap(({ step, markers: found }) =>
          found.map((marker) =>
            step ? { at: [step, ...marker.at], schema: marker.schema } : marker,
          ),
        ),
      ]),
    ]
    const low = Math.min(...children.map((child) => child.low))
    if (low < self) {
      // A node that reached back above itself saw only part of its cycle, so its markers hold until that cycle finishes.
      unfinished.push(schema)
      memo.set(schema, { markers, low })
      return { markers, low }
    }
    for (const member of unfinished.splice(start)) memo.delete(member)
    if (low === self && markers.length > 0) cyclic = true
    const finished = { markers, low: Infinity }
    memo.set(schema, finished)
    return finished
  }
  return { markers: walk(root).markers, cyclic }
}

function childSchemas(schema: z.core.$ZodType): [Step | null, z.core.$ZodType][] {
  if (schema instanceof z.core.$ZodLazy) return [[null, schema._zod.innerType]]
  return Object.entries(schema._zod.def).flatMap(
    ([key, value]): [Step | null, z.core.$ZodType][] => {
      if (key === 'shape') {
        return Object.entries(value as z.core.$ZodShape).map(([name, child]) => [
          { kind: 'property', name, schema: child },
          child,
        ])
      }
      const step: Step | null = SAME_VALUE_DEF_KEYS.has(key) ? null : { kind: 'keyword', name: key }
      if (value instanceof z.core.$ZodType) return [[step, value]]
      if (!Array.isArray(value)) return []
      return value.flatMap((child: unknown, index): [Step | null, z.core.$ZodType][] =>
        child instanceof z.core.$ZodType
          ? [[key === 'items' ? { kind: 'index', index } : step, child]]
          : [],
      )
    },
  )
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
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
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
