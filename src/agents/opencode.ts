import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import type { TAgentAdapter, TAgentSession } from './types'

const DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')

export const opencodeAdapter: TAgentAdapter = {
  kind: 'opencode',
  list(): TAgentSession[] {
    const out: TAgentSession[] = []
    let rows: Array<{ id?: string; directory?: string; title?: string; time_updated?: number }> = []
    try {
      const text = execFileSync(
        'sqlite3',
        ['-readonly', '-json', DB, "select id, directory, coalesce(title,'') as title, time_updated from session_v2"],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      rows = JSON.parse(text || '[]') as typeof rows
    } catch {
      return out
    }
    for (const row of rows) {
      if (!row.id) continue
      const ms = Number(row.time_updated)
      out.push({
        agent: 'opencode',
        id: row.id,
        cwd: row.directory ?? '',
        branches: [],
        title: row.title ?? '',
        path: DB,
        updatedAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
      })
    }
    return out
  },
  resume(session: TAgentSession): string[] {
    return ['opencode', '--session', session.id]
  },
}
