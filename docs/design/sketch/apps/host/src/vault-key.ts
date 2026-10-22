// apps/host — 32 random bytes at $KURUMI_HOME/vault.key (0600), created on first boot. Backed up with kurumi.db.
export function readOrCreateVaultKey(path: string): Uint8Array {
  throw new Error('not implemented')
}
