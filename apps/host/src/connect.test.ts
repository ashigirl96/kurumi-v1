import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountLedger } from '@kurumi/account/server'
import { tokenGmailOnly } from '@kurumi/account/testing'
import { createAgentLedger } from '@kurumi/agent/server'
import { createChatLedger } from '@kurumi/chat/server'
import { inboundMessage, outboundMessage } from '@kurumi/session/schema'
import { createSessionLedger, type RuntimeLog } from '@kurumi/session/server'
import { eq } from 'drizzle-orm'

import { migrateAll, openKurumiDb } from './db.ts'
import { migrations } from './migrations.ts'

test.each(['attach', 'restart', 'crash'] as const)(
  'offline completion recovers the replacement and visible notice once in sequence: %s',
  async (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'kurumi-connect-delivery-'))
    const path = join(home, 'kurumi.db')
    let db = openKurumiDb(path)
    migrateAll(db, migrations)
    const agents = createAgentLedger({ db, home })
    const group = agents.create({ name: 'work' })
    const logs: RuntimeLog[] = []
    let chat = createChatLedger({
      db,
      agentLedger: agents,
      sink: () => ({ onInbound: (event) => sessions.routeInbound(event) }),
    })
    let sessions = createSessionLedger({
      db,
      agentLedger: agents,
      chatLedger: chat,
      runtimeLog: (entry) => logs.push(entry),
    })
    let stream = chat.terminal({ agentGroupId: group.id, text: 'connect gmail', follow: true })
    try {
      const receipt = (await stream.next()).value
      if (!receipt || receipt.kind !== 'queued') throw new Error('missing receipt')
      await stream.return()
      const connections = createAccountLedger({
        db,
        vaultKey: randomBytes(32),
        fetch: Object.assign(async () => Response.json(tokenGmailOnly), {
          preconnect: fetch.preconnect,
        }),
        cards: {
          post: (tx, sessionId, card) => sessions.postCard(tx, sessionId, card),
          replace: (tx, id, card) => sessions.replaceCard(tx, id, card),
          queueNotice: (tx, notice) => sessions.queueNotice(tx, notice),
          deliverNotice: (notice) => {
            if (mode !== 'crash') sessions.deliverNotice(notice)
          },
          deliver: (id) => (mode === 'crash' ? Promise.resolve() : sessions.deliverCard(id)),
        },
      }).connections
      connections.setClient({ clientId: 'fixture', clientSecret: 'fixture' })
      const { requestId } = await connections.connectAgent(
        { services: ['gmail'] },
        { kind: 'agent', agentGroupId: group.id, sessionId: receipt.sessionId },
      )
      const opened = connections.openLink(connections.issueLink(requestId, { kind: 'host' }))
      if (opened.kind !== 'authorize') throw new Error('missing authorize URL')
      const callback = new URL(
        `http://127.0.0.1/oauth/callback?state=${opened.url.searchParams.get('state')}&code=fixture`,
      )
      expect((await connections.callback(callback)).kind).toBe('completed')
      expect((await connections.callback(callback)).kind).toBe('completed')
      const rows = db.select().from(outboundMessage).orderBy(outboundMessage.seq).all()
      expect(rows).toHaveLength(3)
      const [original, replacementRow, noticeRow] = rows
      if (!original || !replacementRow || !noticeRow) throw new Error('missing committed rows')
      expect(noticeRow).toMatchObject({ id: `ntf-visible-${requestId}`, kind: 'text' })
      expect(
        db
          .select()
          .from(inboundMessage)
          .where(eq(inboundMessage.id, `ntf-${requestId}`))
          .get(),
      ).toMatchObject({ kind: 'system', trigger: true })
      if (mode !== 'attach') {
        await sessions.stop()
        chat.stop()
        db.$client.close(true)
        db = openKurumiDb(path)
        const restartedAgents = createAgentLedger({ db, home })
        chat = createChatLedger({
          db,
          agentLedger: restartedAgents,
          sink: () => ({ onInbound: (event) => sessions.routeInbound(event) }),
        })
        sessions = createSessionLedger({
          db,
          agentLedger: restartedAgents,
          chatLedger: chat,
          runtimeLog: (entry) => logs.push(entry),
        })
        await sessions.start()
        expect(
          db.select().from(outboundMessage).where(eq(outboundMessage.id, replacementRow.id)).get()
            ?.status,
        ).toBe('failed')
      }
      stream = chat.terminal({ agentGroupId: group.id, text: '', follow: true })
      expect((await stream.next()).value?.kind).toBe('queued')
      const replacement = (await stream.next()).value
      expect(replacement).toMatchObject({ kind: 'reply', outboundId: replacementRow.id })
      if (!replacement || replacement.kind !== 'reply') throw new Error('missing replacement')
      expect(replacement.text).toContain(`${requestId}\n✅ `)
      expect(replacement.text).not.toContain('kurumi chat press')
      expect((await stream.next()).value).toMatchObject({
        kind: 'reply',
        outboundId: `ntf-visible-${requestId}`,
        text: noticeRow.content,
      })
      await stream.return()
      stream = chat.terminal({ agentGroupId: group.id, text: '', follow: true })
      await stream.next()
      await sessions.postOutbound({
        id: 'after-recovery',
        sessionId: receipt.sessionId,
        text: 'after recovery',
      })
      expect((await stream.next()).value).toMatchObject({ kind: 'reply', text: 'after recovery' })
      expect(
        logs.flatMap((entry) =>
          entry.kind === 'session.outbound.delivered' ? [entry.outboundId] : [],
        ),
      ).toEqual([replacementRow.id, noticeRow.id, 'after-recovery'])
    } finally {
      await stream.return()
      await sessions.stop()
      chat.stop()
      db.$client.close(true)
      rmSync(home, { recursive: true, force: true })
    }
  },
)
