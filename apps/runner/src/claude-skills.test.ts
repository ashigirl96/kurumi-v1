import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function skillResponse(skill: string | undefined): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_skills',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: skill
        ? { type: 'tool_use', id: `toolu_${skill}`, name: 'Skill', input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: skill
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ skill, args: 'help only' }) }
        : { type: 'text_delta', text: 'skills probe done' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: skill ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('fresh and resumed SDK turns hide built-in skills and reject explicit Skill calls', async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/messages') return Response.json({ data: [] })
      const skill = ['loop', 'schedule'][requests.length % 3]
      requests.push(await request.text())
      return skillResponse(skill)
    },
  })
  const workspace = mkdtempSync(join(tmpdir(), 'kurumi-skills-'))
  const script = `
    import { runTurn } from ${JSON.stringify(join(import.meta.dir, 'claude.ts'))}
    let continuation = null
    const replies = []
    const sessions = []
    for (const prompt of ['first skills probe', 'resumed skills probe']) {
      await runTurn({
        prompt, instructions: 'Inspect skill help only. Never create tasks or reminders.',
        continuation, signal: AbortSignal.timeout(30_000),
        reply: async text => { replies.push(text) },
        remember: async id => { continuation = id; sessions.push(id) },
      })
    }
    process.stdout.write(JSON.stringify({ replies, sessions }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workspace,
      ANTHROPIC_BASE_URL: server.url.origin,
      CLAUDE_CODE_OAUTH_TOKEN: ['sk', 'ant', 'kurumi', 'local', 'probe'].join('-'),
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: 'localhost,127.0.0.1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill(), 45_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    const result: unknown = JSON.parse(stdout)
    expect(result).toEqual({
      replies: ['skills probe done', 'skills probe done'],
      sessions: [expect.any(String)],
    })
    expect(requests).toHaveLength(6)
    for (const request of requests) {
      expect({
        advertisedLoop: request.includes('- loop:'),
        advertisedSchedule: request.includes('- schedule:'),
      }).toEqual({ advertisedLoop: false, advertisedSchedule: false })
    }
    for (const index of [2, 5]) {
      expect(requests[index]).toContain("Skill loop is not in this session's skills allowlist")
      expect(requests[index]).toContain("Skill schedule is not in this session's skills allowlist")
      expect(requests[index]).not.toContain('Launching skill:')
    }
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await server.stop(true)
    rmSync(workspace, { recursive: true, force: true })
  }
}, 60_000)
