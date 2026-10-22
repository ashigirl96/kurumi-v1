import { migrations as accountMigrations } from '@kurumi/account/server'
import { migrations as agentMigrations } from '@kurumi/agent/server'

/** A package's tables may reference only the packages before it. */
export const migrations = [agentMigrations, accountMigrations]
