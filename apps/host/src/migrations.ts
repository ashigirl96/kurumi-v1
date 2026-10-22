import { migrations as accountMigrations } from '@kurumi/account/server'
import { migrations as agentMigrations } from '@kurumi/agent/server'

export const migrations = [agentMigrations, accountMigrations]
