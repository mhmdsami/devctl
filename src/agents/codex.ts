import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TAgentAdapter, TAgentSession } from './types'
import { readHead } from './util'

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl')

function readIndex(): Map<string, { title: string; updatedAt: string | null }> {
  const map = new Map<string, { title: string; updatedAt: string | null }>()
  try {
    for (const line of fs.readFileSync(INDEX, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string }
        if (row.id) map.set(row.id, { title: row.thread_name ?? '', updatedAt: row.updated_at ?? null })
      } catch {}
    }
  } catch {}
  return map
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.jsonl')) yield full
  }
}

export const codexAdapter: TAgentAdapter = {
  kind: 'codex',
  list(): TAgentSession[] {
    const out: TAgentSession[] = []
    const index = readIndex()
    for (const file of walk(SESSIONS)) {
      const first = readHead(file, 32 * 1024).split('\n')[0]
      if (!first) continue
      let meta: { payload?: Record<string, unknown> }
      try {
        meta = JSON.parse(first) as { payload?: Record<string, unknown> }
      } catch {
        continue
      }
      const payload = meta.payload ?? {}
      const id = typeof payload.session_id === 'string' ? payload.session_id : typeof payload.id === 'string' ? payload.id : ''
      if (!id) continue
      const git = payload.git as { branch?: string } | undefined
      const indexed = index.get(id)
      out.push({
        agent: 'codex',
        id,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
        branches: git?.branch ? [git.branch] : [],
        title: indexed?.title ?? '',
        path: file,
        updatedAt: indexed?.updatedAt ?? (typeof payload.timestamp === 'string' ? payload.timestamp : null),
      })
    }
    return out
  },
  resume(session: TAgentSession): string[] {
    return ['codex', 'resume', session.id]
  },
}
