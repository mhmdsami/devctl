import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TAgentAdapter, TAgentSession } from './types'
import { matchAll, readHead, readTail, statSafe } from './util'

const ROOT = path.join(os.homedir(), '.claude', 'projects')

export const claudeAdapter: TAgentAdapter = {
  kind: 'claude',
  list(): TAgentSession[] {
    const out: TAgentSession[] = []
    let projects: string[] = []
    try {
      projects = fs.readdirSync(ROOT)
    } catch {
      return out
    }
    for (const project of projects) {
      const dir = path.join(ROOT, project)
      let files: string[] = []
      try {
        files = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const full = path.join(dir, file)
        const id = file.slice(0, -'.jsonl'.length)
        const sample = `${readHead(full)}\n${readTail(full)}`
        const cwd = matchAll(sample, /"cwd":"([^"]+)"/g)[0] ?? ''
        const branches = [...new Set(matchAll(sample, /"gitBranch":"([^"]+)"/g))]
        const titles = matchAll(sample, /"(?:aiTitle|customTitle)":"([^"]*)"/g)
        const stat = statSafe(full)
        out.push({
          agent: 'claude',
          id,
          cwd,
          branches,
          title: titles.length > 0 ? titles[titles.length - 1] : '',
          path: full,
          updatedAt: stat?.mtime ?? null,
        })
      }
    }
    return out
  },
  resume(session: TAgentSession): string[] {
    return ['claude', '--resume', session.id]
  },
}
