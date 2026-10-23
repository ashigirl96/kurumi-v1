import { migrations as accessMigrations } from '@kurumi/access/server'
import { migrations as accountMigrations } from '@kurumi/account/server'
import { migrations as agentMigrations } from '@kurumi/agent/server'
import { migrations as approvalMigrations } from '@kurumi/approval/server'
import { migrations as chatMigrations } from '@kurumi/chat/server'
import { migrations as gatewayMigrations } from '@kurumi/gateway/server'
import { migrations as sessionMigrations } from '@kurumi/session/server'

export const migrations = [
  agentMigrations,
  accountMigrations,
  accessMigrations,
  chatMigrations,
  sessionMigrations,
  gatewayMigrations,
  approvalMigrations,
]
