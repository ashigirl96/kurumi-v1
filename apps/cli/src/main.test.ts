import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { kc } from '@kurumi/rpc/contract'
import { isContractProcedure, type AnyContractRouter } from '@orpc/contract'
import { z } from 'zod'
import * as zm from 'zod/mini'

import { chat, cliContract, runCommand, type Stdin } from './main.ts'

type Call = { path: readonly string[]; input: unknown }

let calls: Call[]
let stdout: string
let stderr: string

beforeEach(() => {
  calls = []
  stdout = ''
  stderr = ''
  spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  mock.restore()
})

const link = {
  async call(path: readonly string[], input: unknown) {
    calls.push({ path, input })
    if (path.at(-1) === 'connect') return { url: 'http://127.0.0.1:42331/connect/test-token' }
    return path.at(-1) === 'addKey' ? { handle: 'anthropic/main' } : { ok: true }
  },
}

function piped(...chunks: (string | Uint8Array)[]): Stdin {
  return {
    isTTY: false,
    chunks: (async function* () {
      for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    })(),
  }
}

const run = (argv: string[], stdin: Stdin, contract: AnyContractRouter = cliContract) =>
  runCommand(argv, { contract, link, stdin })

const addKey = ['account', 'add-key', 'anthropic', '--label', 'main']

test('account set-client reads the client JSON only from stdin', async () => {
  const client = JSON.stringify({ clientId: 'test-client', clientSecret: 'test-secret' })
  expect(await run(['account', 'set-client', 'google'], piped(client))).toBe(0)
  expect(calls).toEqual([{ path: ['account', 'setClient'], input: ['google', { client }] }])
  expect(stdout).not.toContain('test-secret')
  expect(stderr).toBe('')
})

test.each(['--value', '--client', '--client-id', '--client-secret'])(
  'account set-client rejects the %s flag',
  async (flag) => {
    expect(await run(['account', 'set-client', 'google', flag, 'sentinel'], piped(''))).toBe(1)
    expect(calls).toEqual([])
    expect(stderr).toContain('unknown option')
    expect(stderr).not.toContain('sentinel')
  },
)

test.each(['not-json', '{"clientId":"sentinel"}', '{"clientId":{},"clientSecret":"sentinel"}'])(
  'account set-client rejects malformed stdin without echoing it: %s',
  async (value) => {
    expect(await run(['account', 'set-client', 'google'], piped(value))).toBe(1)
    expect(calls).toEqual([])
    expect(stderr).toContain('stdin must be JSON with clientId and clientSecret')
    expect(stderr).not.toContain('sentinel')
  },
)

test('account connect prints a plain link for the requested services and group', async () => {
  expect(
    await run(
      ['account', 'connect', '--services', 'gmail', 'google-calendar', '--agent-group-id', 'work'],
      piped(''),
    ),
  ).toBe(0)
  expect(calls).toEqual([
    {
      path: ['account', 'connect'],
      input: { services: ['gmail', 'google-calendar'], agentGroupId: 'work' },
    },
  ])
  expect(stdout).toBe('http://127.0.0.1:42331/connect/test-token\n')
})

test('account list shows needs_reauth and active beside each account', async () => {
  const accounts = ['needs_reauth', 'active'].map((status, index) => ({
    handle: `google/test-${index}`,
    kind: 'oauth',
    services: ['gmail'],
    autoGrant: false,
    status,
  }))
  expect(
    await runCommand(['account', 'list'], {
      contract: cliContract,
      link: answering(accounts),
      stdin: piped(''),
    }),
  ).toBe(0)
  expect(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/)),
  ).toEqual([
    ['google/test-0', 'oauth', 'gmail', 'needs_reauth'],
    ['google/test-1', 'oauth', 'gmail', 'active'],
  ])
})

test('the CLI builds from the full host contract and status answers', async () => {
  expect(await run(['status'], piped(''))).toBe(0)

  expect(calls.map(({ path }) => path)).toEqual([['status']])
  expect(stderr).toBe('')
})

describe('account add-key', () => {
  test.each([
    ['LF', 'sk-ant-one\n'],
    ['CRLF', 'sk-ant-one\r\n'],
    ['no newline', 'sk-ant-one'],
    ['UTF-8 byte order mark before it and LF', '\uFEFFsk-ant-one\n'],
  ])('sends the piped key with one %s removed and prints the handle', async (_, text) => {
    expect(await run(addKey, piped(text))).toBe(0)

    expect(calls).toEqual([
      {
        path: ['account', 'addKey'],
        input: ['anthropic', { label: 'main', autoGrant: false, value: 'sk-ant-one' }],
      },
    ])
    expect(stdout).toBe('anthropic/main\n')
  })

  test('has no --value option, so the key cannot go through argv', async () => {
    expect(await run([...addKey, '--value', 'sk-ant-one'], piped('sk-ant-one'))).toBe(1)

    expect(stderr).toContain("unknown option '--value'")
    expect(calls).toEqual([])
  })

  test.each([
    ['empty', '', 'stdin was empty, so there is no value'],
    ['only a newline', '\n', 'stdin was empty, so there is no value'],
    ['whitespace', 'sk-ant one\n', 'value contains whitespace'],
    ['a second line', 'sk-ant-one\nsk-ant-two\n', 'value contains whitespace'],
    ['two trailing newlines', 'sk-ant-one\n\n', 'value contains whitespace'],
    ['a NUL', 'sk-ant\0one', 'value contains a control character'],
    ['non-ASCII', 'sk-ant-é', 'value contains a non-ASCII character'],
  ])('refuses stdin that is %s before calling the host', async (_, text, problem) => {
    expect(await run(addKey, piped(text))).toBe(1)

    expect(stderr).toBe(`BAD_REQUEST: ${problem}\n`)
    expect(calls).toEqual([])
  })

  test('refuses stdin that is not UTF-8 instead of replacing the bad bytes', async () => {
    expect(await run(addKey, piped(Uint8Array.of(0x73, 0x6b, 0xff, 0xfe)))).toBe(1)

    expect(stderr).toBe('BAD_REQUEST: stdin is not valid UTF-8, so it holds no value\n')
    expect(calls).toEqual([])
  })

  test('stops reading a long stdin once it is past the key length cap', async () => {
    let read = 0
    const mebibyte: Stdin = {
      isTTY: false,
      chunks: (async function* () {
        for (let chunk = 0; chunk < 1024; chunk++) {
          read += 1024
          yield new Uint8Array(1024).fill(0x6b)
        }
      })(),
    }

    expect(await run(addKey, mebibyte)).toBe(1)

    expect(stderr).toBe('BAD_REQUEST: stdin is longer than the 4096 characters value may hold\n')
    expect(read).toBeLessThan(64 * 1024)
    expect(calls).toEqual([])
  })

  test('refuses a terminal stdin without reading it', async () => {
    let read = false
    const terminal: Stdin = {
      isTTY: true,
      chunks: (async function* () {
        read = true
        yield Buffer.from('sk-ant-one')
      })(),
    }

    expect(await run(addKey, terminal)).toBe(1)

    expect(stderr).toContain('value is read from stdin, so pipe it in')
    expect(read).toBe(false)
    expect(calls).toEqual([])
  })
})

const secret = z.string().max(16)

const put = (options: z.ZodObject) =>
  kc
    .meta({ cli: true })
    .input(z.tuple([z.string().describe('name'), options]))
    .output(z.object({ ok: z.boolean() }))

const same = (value: string) => value

describe('a contract field marked stdin', () => {
  test.each([
    ['optional', secret.meta({ stdin: true }).optional()],
    ['marked after optional', secret.optional().meta({ stdin: true })],
    ['defaulted', secret.meta({ stdin: true }).default('unused')],
    ['nullable', secret.meta({ stdin: true }).nullable()],
    ['marked with an id', secret.meta({ stdin: true, id: 'Secret' })],
    ['the output of a pipe', z.string().pipe(secret.meta({ stdin: true }))],
    [
      'the output of a pipe after a transform',
      z
        .string()
        .transform(same)
        .pipe(secret.meta({ stdin: true })),
    ],
    [
      'the output of a pipe after a codec',
      z
        .codec(z.string(), z.string(), { decode: same, encode: same })
        .pipe(secret.meta({ stdin: true })),
    ],
    [
      'the middle of a pipe chain',
      z
        .string()
        .pipe(secret.meta({ stdin: true }))
        .pipe(z.string()),
    ],
  ])('is read from stdin when %s, and gets no flag', async (_, field) => {
    const contract = { put: put(z.object({ label: z.string(), secret: field })) }

    expect(await run(['put', 'n', '--label', 'l'], piped('s3cret\n'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { label: 'l', secret: 's3cret' }] }])

    calls = []
    stderr = ''
    expect(
      await run(['put', 'n', '--label', 'l', '--secret', 's3cret'], piped('s3cret'), contract),
    ).toBe(1)
    expect(stderr).toContain("unknown option '--secret'")
    expect(calls).toEqual([])
  })

  test.each([
    ['a default value', z.object({ stdin: z.boolean() }).default({ stdin: true })],
    ['examples', z.string().meta({ examples: [{ stdin: true }] })],
  ])('is not found in %s that only hold stdin: true as data', async (_, label) => {
    const contract = {
      put: put(z.object({ label, secret: secret.meta({ stdin: true }) })),
    }

    expect(await run(['put', 'n', '--help'], piped(''), contract)).toBe(0)
    expect(stdout).toContain('--label')
    expect(stdout).not.toContain('--secret')
  })

  test('is read from stdin when the command name holds an acronym', async () => {
    const contract = { putDB: put(z.object({ secret: secret.meta({ stdin: true }) })) }

    expect(await run(['put-db', 'n'], piped('s3cret'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['putDB'], input: ['n', { secret: 's3cret' }] }])

    calls = []
    expect(await run(['put-db', 'n', '--secret', 'ARGV'], piped(''), contract)).toBe(1)
    expect(stderr).toContain("unknown option '--secret'")
    expect(calls).toEqual([])
  })

  test('is read from stdin beside a recursive schema', async () => {
    type Tree = { children: Tree[] }
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ children: z.array(tree) }))
    const contract = {
      put: put(z.object({ tree: tree.optional(), secret: secret.meta({ stdin: true }) })),
    }

    expect(await run(['put', 'n'], piped('s3cret'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { secret: 's3cret' }] }])
  })

  test('is read from stdin in a zod mini input, and gets no flag', async () => {
    const options = zm.object({
      label: zm.string(),
      secret: zm.string().check(zm.maxLength(16)).register(zm.globalRegistry, { stdin: true }),
    })
    const contract = { put: kc.meta({ cli: true }).input(zm.tuple([zm.string(), options])) }

    expect(await run(['put', 'n', '--label', 'l'], piped('s3cret'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { label: 'l', secret: 's3cret' }] }])

    calls = []
    expect(await run(['put', 'n', '--label', 'l', '--secret', 'ARGV'], piped(''), contract)).toBe(1)
    expect(calls).toEqual([])
  })

  const marked = secret.meta({ stdin: true })

  test('reads a repeated stdin marker in one field once, and gets no flag', async () => {
    const contract = {
      put: put(z.object({ secret: z.union([marked, marked]) })),
    }

    expect(await run(['put', 'n'], piped('s3cret\n'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { secret: 's3cret' }] }])
    expect(stderr).toBe('')

    calls = []
    expect(await run(['put', 'n', '--secret', 'ARGV'], piped('s3cret'), contract)).toBe(1)
    expect(stderr).toContain("unknown option '--secret'")
    expect(calls).toEqual([])
  })

  test('walks a shared union chain without exponential schema visits', async () => {
    let field: z.ZodType = marked
    for (let depth = 0; depth < 35; depth++) field = z.union([field, field])
    const contract = { put: put(z.object({ secret: field })) }
    const getMetadata = z.globalRegistry.get.bind(z.globalRegistry)
    let visits = 0
    spyOn(z.globalRegistry, 'get').mockImplementation((schema) => {
      if (++visits > 1000) throw new Error('stdin marker walk exceeded 1000 schema visits')
      return getMetadata(schema)
    })

    expect(await run(['put', 'n'], piped('s3cret'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { secret: 's3cret' }] }])
    expect(visits).toBeLessThan(1000)
  })

  test('walks a cyclic chain without exponential schema visits', async () => {
    let chain: z.ZodType = z.lazy(() => chain)
    for (let depth = 0; depth < 20; depth++) chain = z.object({ a: chain, b: chain })
    const contract = { put: put(z.object({ chain: chain.optional(), secret: marked })) }
    const getMetadata = z.globalRegistry.get.bind(z.globalRegistry)
    let visits = 0
    spyOn(z.globalRegistry, 'get').mockImplementation((schema) => {
      if (++visits > 1000) throw new Error('stdin marker walk exceeded 1000 schema visits')
      return getMetadata(schema)
    })

    expect(await run(['put', 'n'], piped('s3cret'), contract)).toBe(0)
    expect(calls).toEqual([{ path: ['put'], input: ['n', { secret: 's3cret' }] }])
    expect(visits).toBeLessThan(1000)
  })

  test.each(
    Object.entries({
      object: z.object({ inner: marked }),
      catchall: z.object({}).catchall(marked),
      array: z.array(marked),
      tuple: z.tuple([marked]),
      'tuple rest': z.tuple([z.string()], marked),
      record: z.record(z.string(), marked),
      map: z.map(z.string(), marked),
      set: z.set(marked),
      union: z.union([marked, z.number()]),
      'discriminated union': z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), inner: marked }),
      ]),
      intersection: z.intersection(marked, z.string()),
      'pipe input': marked.pipe(z.string()),
      'pipe output': z.string().pipe(marked),
      codec: z.codec(marked, z.string(), { decode: same, encode: same }),
      preprocess: z.preprocess(same, marked),
      lazy: z.lazy(() => marked),
      promise: z.promise(marked),
      optional: marked.optional(),
      nullable: marked.nullable(),
      default: marked.default('unused'),
      prefault: marked.prefault('unused'),
      catch: marked.catch('unused'),
      readonly: marked.readonly(),
      nonoptional: marked.optional().nonoptional(),
      success: z.success(marked),
      function: z.function({ input: [marked], output: z.string() }),
      'template literal': z.templateLiteral([marked]),
    }),
  )('marked inside %s never sends an argv value', async (_, field) => {
    const contract = { put: put(z.object({ label: z.string(), secret: field })) }

    await run(['put', 'n', '--label', 'l', '--secret', 'ARGV'], piped('s3cret'), contract)

    expect(JSON.stringify(calls)).not.toContain('ARGV')
  })

  const cyclic = {
    options: z.object({
      s: marked,
      get loop() {
        return cyclic.back
      },
    }),
    back: z.object({
      get back() {
        return cyclic.options
      },
    }),
  }

  test.each([
    [
      'a positional',
      kc.meta({ cli: true }).input(z.tuple([marked, z.object({ label: z.string() })])),
      'input[0] is marked stdin, but only a field of the trailing options object can be',
    ],
    [
      'a nested field',
      put(z.object({ auth: z.object({ secret: marked }) })),
      'input[1].auth.secret is marked stdin, but only a field of the trailing options object can be',
    ],
    [
      'an array element',
      put(z.object({ secrets: z.array(marked) })),
      'input[1].secrets<element> is marked stdin, but only a field of the trailing options object can be',
    ],
    [
      'two fields',
      put(z.object({ a: marked, b: marked })),
      'input[1].a and input[1].b are each marked stdin, but only one field can be',
    ],
    [
      'a cycle the walk first enters halfway',
      kc.meta({ cli: true }).input(z.tuple([z.string(), cyclic.options], cyclic.back)),
      'input[1].s and input<rest>.back.s are each marked stdin, but only one field can be',
    ],
    [
      'a cycle through the options object',
      put(cyclic.options),
      'input[1].s is marked stdin, but a recursive schema reaches it again',
    ],
    [
      'an object input',
      kc.meta({ cli: true }).input(z.object({ secret: marked })),
      'input.secret is marked stdin, but only a field of the trailing options object can be',
    ],
    [
      'a field with no maximum length',
      put(z.object({ secret: z.string().meta({ stdin: true }) })),
      'input[1].secret needs a maximum length',
    ],
  ])(
    'in %s refuses that command with one line instead of becoming a flag',
    async (_, procedure, why) => {
      const contract = { ...cliContract, put: procedure }

      expect(await run(['put'], piped(''), contract)).toBe(1)

      expect(stderr).toBe(`kurumi put cannot read stdin: ${why}\n`)
      expect(calls).toEqual([])

      stderr = ''
      expect(await run(['status'], piped(''), contract)).toBe(0)
      expect(stderr).toBe('')
      expect(calls).toEqual([{ path: ['status'], input: undefined }])
    },
  )
})

const commandsOf = (contract: AnyContractRouter, path: string[] = []): string[][] =>
  Object.entries(contract).flatMap(([key, child]) => {
    const command = [...path, key.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)]
    if (!isContractProcedure(child)) return commandsOf(child, command)
    return child['~orpc'].meta.cli === true ? [command] : []
  })

test.each(commandsOf(cliContract).map((command) => [command.join(' '), command]))(
  'kurumi %s --help builds the command from the host contract',
  async (_, command) => {
    expect(await run([...command, '--help'], piped(''))).toBe(0)

    expect(stderr).toBe('')
    expect(calls).toEqual([])
  },
)

// Commander exits the process itself for a group's help and unknown commands, so these run the CLI as a child.
function kurumi(argv: string[]) {
  const child = Bun.spawnSync([process.execPath, `${import.meta.dir}/main.ts`, ...argv], {
    env: { ...process.env, KURUMI_HOME: `${import.meta.dir}/no-host` },
    stdin: 'ignore',
  })
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

function helpOf(command: string[]): string {
  const { code, stdout: help, stderr: error } = kurumi([...command, '--help'])
  expect({ code, error }).toEqual({ code: 0, error: '' })
  return help
}

test('kurumi --help names every command', () => {
  const help = helpOf([])

  for (const name of new Set(commandsOf(cliContract).flat())) expect(help).toContain(name)
})

test.each(commandsOf(cliContract).map((command) => [command.join(' '), command]))(
  'kurumi %s is listed in its group help with the arguments and options of its own help',
  (_, command) => {
    const own = helpOf(command)
    const args = own.split('\n')[0]!.replace(`Usage: kurumi ${command.join(' ')} [options]`, '')
    const options = /^ {2}--/m.test(own) ? ' [options]' : ''
    const term = `  ${command.at(-1)}${options}${args}`

    const terms = helpOf(command.slice(0, -1))
      .split('\n')
      .map((line) => line.slice(0, term.length + 1).trimEnd())

    expect(terms).toContain(term)
  },
)

test.each([
  [['nope'], "error: unknown command 'nope'", []],
  [['account', 'nope'], "error: unknown command 'nope'", ['account']],
  [['approval', 'show'], "error: missing required argument 'approval id'", ['approval', 'show']],
  [
    ['account', 'add-key', 'anthropic'],
    "error: required option '--label <string>' not specified",
    ['account', 'add-key'],
  ],
])('kurumi %p exits 1 with one error line and then the help', (argv, error, command) => {
  const { code, stdout: output, stderr: printed } = kurumi(argv)

  expect({ code, output }).toEqual({ code: 1, output: '' })
  expect(printed).toBe(`${error}\n\n${helpOf(command)}`)
})

test('a flag value the input schema refuses exits 1 with a BAD_REQUEST line', async () => {
  expect(await run(['gateway', 'log', '--limit', 'abc'], piped(''))).toBe(1)

  expect(stderr).toBe(
    "BAD_REQUEST: error: option '--limit [integer]' argument 'abc' is invalid. Invalid input: expected number, received string\n",
  )
  expect(calls).toEqual([])
})

function answering(output: unknown) {
  return {
    async call(path: readonly string[], input: unknown) {
      calls.push({ path, input })
      return output
    },
  }
}

describe('gateway', () => {
  const row = {
    at: new Date('2026-10-24T00:00:00.000Z'),
    agentGroupId: 'g1',
    sessionId: 's1',
    host: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    account: 'anthropic/main',
    service: 'anthropic-api',
    decision: 'injected',
    refusal: null,
    status: 200,
    durationMs: 812,
  }

  test('log sends the filters and prints account, service, decision, and status in a row', async () => {
    const refused = {
      ...row,
      account: null,
      decision: 'refused',
      refusal: 'account_not_connected',
      status: 403,
      durationMs: 3,
    }
    const argv = ['gateway', 'log', '--agent-group-id', 'g1', '--account', 'anthropic/main']
    expect(
      await runCommand(argv, {
        contract: cliContract,
        link: answering([row, refused]),
        stdin: piped(''),
      }),
    ).toBe(0)

    expect(calls).toEqual([
      {
        path: ['gateway', 'log'],
        input: { agentGroupId: 'g1', account: 'anthropic/main', limit: 100 },
      },
    ])
    expect(stdout.split('\n')).toEqual([
      '2026-10-24T00:00:00.000Z  anthropic/main  anthropic-api  injected  200  812ms  POST  api.anthropic.com/v1/messages  g1',
      '2026-10-24T00:00:00.000Z  -               anthropic-api  refused   403  3ms    POST  api.anthropic.com/v1/messages  g1  account_not_connected',
      '',
    ])
  })

  test('status prints admission, the Agent Port address, and the CA fingerprint', async () => {
    const status = {
      admission: 'open',
      detail: null,
      agentPort: { host: '127.0.0.1', port: 4000 },
      caFingerprint: 'AB:CD',
    }
    expect(
      await runCommand(['gateway', 'status'], {
        contract: cliContract,
        link: answering(status),
        stdin: piped(''),
      }),
    ).toBe(0)

    expect(stdout).toBe('admission   open\nagent port  127.0.0.1:4000\nca sha256   AB:CD\n')
  })
})

test.each([
  { kind: 'private-link', url: 'http://127.0.0.1:42331/connect/test-token' },
  { kind: 'notice', text: 'この group の承認者だけが接続できます' },
  { kind: 'notice', text: 'このカードは利用できません。もう一度接続を頼んでください' },
] as const)('chat press prints only its private reply: $kind', async (reply) => {
  expect(
    await chat(['press', 'cr-test', 'connect'], {
      async call(path, input) {
        calls.push({ path, input })
        return reply
      },
    }),
  ).toBe(reply.kind === 'notice' ? 1 : 0)
  expect(calls).toEqual([{ path: ['chat', 'press'], input: { ref: 'cr-test', action: 'connect' } }])
  expect(stdout).toBe(`${reply.kind === 'private-link' ? reply.url : reply.text}\n`)
})
