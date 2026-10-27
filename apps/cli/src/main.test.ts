import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { kc } from '@kurumi/rpc/contract'
import type { AnyContractRouter } from '@orpc/contract'
import { z } from 'zod'
import * as zm from 'zod/mini'

import { cliContract, runCommand, type Stdin } from './main.ts'

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
    'in %s refuses every command with one line instead of becoming a flag',
    async (_, procedure, why) => {
      const contract = { ...cliContract, put: procedure }

      expect(await run(['status'], piped(''), contract)).toBe(1)

      expect(stderr).toBe(`kurumi put cannot read stdin: ${why}\n`)
      expect(calls).toEqual([])
    },
  )
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
