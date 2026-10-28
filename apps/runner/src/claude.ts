import { join } from 'node:path'

import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

export type Turn = {
  prompt: string
  continuation: string | null
  mcpServers?(): Options['mcpServers']
  signal: AbortSignal
  reply(text: string): Promise<void>
  remember(continuation: string): Promise<void>
}

const inheritedNames = new Set([
  'HOME',
  'PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
])
const inheritedPrefixes = ['ANTHROPIC_', 'CLAUDE_CODE_']

// Claude Code hands its env to every tool the model runs, so the runner's KURUMI_* stays behind.
function claudeCodeEnv(workspace: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (inheritedNames.has(entry[0]) ||
        inheritedPrefixes.some((prefix) => entry[0].startsWith(prefix))),
  )
  return {
    ...Object.fromEntries(inherited),
    CLAUDE_CONFIG_DIR: join(workspace, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

function options(
  turn: Turn,
  continuation: string | null,
  abortController: AbortController,
): Options {
  const workspace = process.cwd()
  return {
    cwd: workspace,
    mcpServers: turn.mcpServers?.(),
    abortController,
    ...(continuation === null ? {} : { resume: continuation }),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: claudeCodeEnv(workspace),
  }
}

function textOf(message: Extract<SDKMessage, { type: 'assistant' }>): string {
  return message.message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
}

function refusalOf(text: string): { error: string; next: string } | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    const body: unknown = JSON.parse(text.slice(start))
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string' &&
      'next' in body &&
      typeof body.next === 'string'
    )
      return { error: body.error, next: body.next }
  } catch {}
  return null
}

function noticeOf(result: SDKResultMessage): string {
  const text = result.subtype === 'success' ? result.result : result.errors.join('\n')
  const status = result.subtype === 'success' ? (result.api_error_status ?? null) : null
  if (status === null) return `Provider error: ${text}`
  const refusal = refusalOf(text)
  return refusal
    ? `Provider error ${status} ${refusal.error}: ${refusal.next}`
    : `Provider error ${status}: ${text}`
}

async function attempt(turn: Turn, continuation: string | null): Promise<string | null> {
  turn.signal.throwIfAborted()
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  turn.signal.addEventListener('abort', abort, { once: true })
  const messages = query({
    prompt: turn.prompt,
    options: options(turn, continuation, abortController),
  })
  let failed: SDKResultMessage | null = null
  let background = false
  try {
    while (true) {
      let next: IteratorResult<SDKMessage, void>
      try {
        next = await messages.next()
      } catch (error) {
        turn.signal.throwIfAborted()
        if (failed) break
        return `Provider error: ${error instanceof Error ? error.message : String(error)}`
      }
      if (next.done) break
      const message = next.value
      if (
        message.type === 'system' &&
        message.subtype === 'init' &&
        message.session_id !== continuation
      )
        await turn.remember(message.session_id)
      if (
        message.type === 'assistant' &&
        message.parent_tool_use_id == null &&
        message.error === undefined
      ) {
        const text = textOf(message)
        if (text) await turn.reply(text)
      }
      if (
        message.type === 'system' &&
        message.subtype === 'background_tasks_changed' &&
        message.tasks.length > 0
      )
        background = true
      if (message.type === 'result' && message.is_error) failed = message
      // Claude Code exits seconds after its last result, yet background work, even finished, wakes it for
      // another turn, and a resumed process first closes a leftover notification without a model turn.
      if (
        message.type === 'result' &&
        !background &&
        !(message.subtype === 'success' && message.num_turns === 0 && message.result === '')
      )
        break
    }
  } catch (error) {
    abort()
    throw error
  } finally {
    turn.signal.removeEventListener('abort', abort)
  }
  if (!failed) return null
  if (
    continuation !== null &&
    failed.subtype === 'error_during_execution' &&
    failed.errors.some((error) => error.startsWith('No conversation found'))
  )
    return attempt(turn, null)
  return noticeOf(failed)
}

export async function runTurn(turn: Turn): Promise<void> {
  const notice = await attempt(turn, turn.continuation)
  if (notice !== null) await turn.reply(notice)
}
