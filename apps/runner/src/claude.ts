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
  signal: AbortSignal
  reply(text: string): Promise<void>
  remember(continuation: string): Promise<void>
}

function options(continuation: string | null, abortController: AbortController): Options {
  const workspace = process.cwd()
  return {
    cwd: workspace,
    abortController,
    ...(continuation === null ? {} : { resume: continuation }),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(workspace, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Claude Code refuses bypassPermissions as root unless it is told the container is the sandbox.
      IS_SANDBOX: '1',
    },
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
  const messages = query({ prompt: turn.prompt, options: options(continuation, abortController) })
  let failed: SDKResultMessage | null = null
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
      if (message.type === 'assistant' && message.error === undefined) {
        const text = textOf(message)
        if (text) await turn.reply(text)
      }
      if (message.type === 'result' && message.is_error) failed = message
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
