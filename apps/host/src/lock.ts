import { dlopen } from 'bun:ffi'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: ['int', 'int'], returns: 'int' },
})
const LOCK_EX = 2
const LOCK_NB = 4

export function acquireLock(path: string): () => void {
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK,
    0o600,
  )
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw new Error(`${path} is not a regular file`)
  }
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)
    const deadline = performance.now() + 500
    let pid = readFileSync(path, 'utf8').trim()
    while (!pid && performance.now() < deadline) {
      Bun.sleepSync(10)
      pid = readFileSync(path, 'utf8').trim()
    }
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
