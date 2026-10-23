import { dlopen } from 'bun:ffi'
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs'

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: ['int', 'int'], returns: 'int' },
})
const LOCK_EX = 2
const LOCK_NB = 4

export function acquireLock(path: string): () => void {
  const fd = openSync(path, 'a+', 0o600)
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const pid = readFileSync(fd, 'utf8').trim()
    closeSync(fd)
    throw new Error(`${path} is held by host pid ${pid || 'unknown'}`)
  }
  try {
    ftruncateSync(fd, 0)
    writeSync(fd, `${process.pid}\n`)
  } catch (error) {
    closeSync(fd)
    throw error
  }
  return () => closeSync(fd)
}
