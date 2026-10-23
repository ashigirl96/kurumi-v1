import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { contract as accountContract } from '@kurumi/account/contract'
import { kc } from '@kurumi/rpc/contract'
import type { AnyContractRouter } from '@orpc/contract'
import { z } from 'zod'

import { runCommand, type Stdin } from './main.ts'

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

const run = (
  argv: string[],
  stdin: Stdin,
  contract: AnyContractRouter = { account: accountContract },
) => runCommand(argv, { contract, link, stdin })

const addKey = ['account', 'add-key', 'anthropic', '--label', 'main']

describe('account add-key', () => {
  test.each([
    ['LF', 'sk-ant-one\n'],
    ['CRLF', 'sk-ant-one\r\n'],
    ['no newline', 'sk-ant-one'],
  ])('sends the piped key with one trailing %s removed and prints the handle', async (_, text) => {
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

  test('stops reading an endless stdin once it is past the key length cap', async () => {
    let read = 0
    const endless: Stdin = {
      isTTY: false,
      chunks: (async function* () {
        for (;;) {
          read += 1024
          yield new Uint8Array(1024).fill(0x6b)
        }
      })(),
    }

    expect(await run(addKey, endless)).toBe(1)

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

describe('a contract field marked stdin', () => {
  test.each([
    ['optional', secret.meta({ stdin: true }).optional()],
    ['marked after optional', secret.optional().meta({ stdin: true })],
    ['defaulted', secret.meta({ stdin: true }).default('unused')],
    ['nullable', secret.meta({ stdin: true }).nullable()],
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
    [
      'a positional',
      kc
        .meta({ cli: true })
        .input(z.tuple([secret.meta({ stdin: true }), z.object({ label: z.string() })])),
      'only one field of the trailing options object may be marked stdin',
    ],
    [
      'a nested field',
      put(z.object({ auth: z.object({ secret: secret.meta({ stdin: true }) }) })),
      'only one field of the trailing options object may be marked stdin',
    ],
    [
      'one of two fields',
      put(z.object({ a: secret.meta({ stdin: true }), b: secret.meta({ stdin: true }) })),
      'only one field of the trailing options object may be marked stdin',
    ],
    [
      'an object input',
      kc.meta({ cli: true }).input(z.object({ secret: secret.meta({ stdin: true }) })),
      'only one field of the trailing options object may be marked stdin',
    ],
    [
      'a field with no maximum length',
      put(z.object({ secret: z.string().meta({ stdin: true }) })),
      'secret needs a maximum length',
    ],
  ])('in %s fails the CLI closed instead of becoming a flag', async (_, procedure, why) => {
    const refused = await run(['put', '--help'], piped(''), { put: procedure }).catch(
      (error: unknown) => error,
    )

    expect(refused).toEqual(new Error(`kurumi put cannot read stdin: ${why}`))
    expect(calls).toEqual([])
  })
})
