import fs from 'fs'

export function readHead(file: string, bytes = 64 * 1024): string {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    fs.closeSync(fd)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  }
}

export function readTail(file: string, bytes = 64 * 1024): string {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - bytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    const read = fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  }
}

export function statSafe(file: string): { mtime: string; size: number } | null {
  try {
    const stat = fs.statSync(file)
    return { mtime: stat.mtime.toISOString(), size: stat.size }
  } catch {
    return null
  }
}

export function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1])
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
