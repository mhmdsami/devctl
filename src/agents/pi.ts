import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TAgentAdapter, TAgentSession } from './types'
import { readHead, statSafe } from './util'

const ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions')

export const piAdapter: TAgentAdapter = {
  kind: 'pi',
  list(): TAgentSession[] {
    const out: TAgentSession[] = []
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(ROOT)
    } catch {
      return out
    }
    for (const dir of dirs) {
      const full = path.join(ROOT, dir)
      let files: string[] = []
      try {
        files = fs.readdirSync(full)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(full, file)
        const head = readHead(filePath, 32 * 1024)
        const first = head.split('\n')[0]
        if (!first) continue
        let record: { type?: string; id?: string; cwd?: string }
        try {
          record = JSON.parse(first) as { type?: string; id?: string; cwd?: string }
        } catch {
          continue
        }
        if (record.type !== 'session') continue
        const id = record.id ?? file.replace(/^.*_/, '').replace(/\.jsonl$/, '')
        const name = head.match(/"name":"([^"]+)"/)
        const stat = statSafe(filePath)
        out.push({
          agent: 'pi',
          id,
          cwd: typeof record.cwd === 'string' ? record.cwd : '',
          branches: [],
          title: name?.[1] ?? '',
          path: filePath,
          updatedAt: stat?.mtime ?? null,
        })
      }
    }
    return out
  },
  resume(session: TAgentSession): string[] {
    return ['pi', '--session', session.id]
  },
}
