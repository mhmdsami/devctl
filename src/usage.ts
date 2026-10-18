import fs from 'fs'
import path from 'path'
import { DEVCTL_DIR } from './store'

export const USAGE_FILE = path.join(DEVCTL_DIR, 'usage.jsonl')

const MAX_BYTES = 1024 * 1024
const KEEP_LINES = 2_000

const SUBS: Record<string, string[]> = {
  env: ['test', 'prod', 'show', 'set', 'unset', 'edit'],
  stack: ['ls', 'up', 'down', 'add', 'create', 'delete'],
  agent: ['register', 'assign', 'unassign', 'note', 'resume'],
  config: ['show', 'get', 'set'],
  portless: ['start', 'stop', 'status'],
}

export interface TUsageEvent {
  ts: string
  cmd: string
  sub?: string
  ok: boolean
  ms: number
}

export function recordUsage(argv: string[], ok: boolean, ms: number): void {
  if (process.env.DEVCTL_TELEMETRY === '0') return
  try {
    const args = argv.filter((arg) => arg !== '--no-color' && arg !== '--quiet')
    const cmd = args[0]
    if (!cmd || cmd.startsWith('-') || cmd.startsWith('_')) return
    const sub = SUBS[cmd]?.includes(args[1] ?? '') ? args[1] : args.includes('--help') || args.includes('-h') ? 'help' : undefined
    const event: TUsageEvent = { ts: new Date().toISOString(), cmd, ...(sub ? { sub } : {}), ok, ms }
    fs.mkdirSync(DEVCTL_DIR, { recursive: true })
    fs.appendFileSync(USAGE_FILE, `${JSON.stringify(event)}\n`)
    rotate()
  } catch {}
}

function rotate(): void {
  try {
    if (fs.statSync(USAGE_FILE).size <= MAX_BYTES) return
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(USAGE_FILE, `${lines.slice(-KEEP_LINES).join('\n')}\n`)
  } catch {}
}

export interface TUsageCount {
  cmd: string
  sub?: string
  count: number
  ok: number
  lastAt: string
}

export function usageEvents(): TUsageEvent[] {
  try {
    return fs
      .readFileSync(USAGE_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TUsageEvent)
  } catch {
    return []
  }
}

export function summarizeUsage(events = usageEvents()): TUsageCount[] {
  const counts = new Map<string, TUsageCount>()
  for (const event of events) {
    const key = event.sub ? `${event.cmd} ${event.sub}` : event.cmd
    const entry = counts.get(key) ?? { cmd: event.cmd, sub: event.sub, count: 0, ok: 0, lastAt: event.ts }
    entry.count++
    if (event.ok) entry.ok++
    if (event.ts > entry.lastAt) entry.lastAt = event.ts
    counts.set(key, entry)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}
