import path from 'path'
import { loadConfig, repoDir } from '../config'
import { listWorktrees } from '../registry'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { opencodeAdapter } from './opencode'
import { piAdapter } from './pi'
import type { TAgentAdapter, TAgentSession } from './types'
import type { TDevctlState } from '../state'

export type { TAgentSession, TAgentAdapter } from './types'

export const adapters: TAgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter, piAdapter]

export function sessionKey(session: { agent: string; id: string }): string {
  return `${session.agent}:${session.id}`
}

export function adapterFor(agent: string): TAgentAdapter | undefined {
  return adapters.find((adapter) => adapter.kind === agent)
}

export function allSessions(): TAgentSession[] {
  const out: TAgentSession[] = []
  for (const adapter of adapters) {
    try {
      out.push(...adapter.list())
    } catch {}
  }
  return out
}

export function repoForCwd(cwd: string): string | null {
  if (!cwd) return null
  const services = loadConfig().services
  let best: string | null = null
  let bestLen = -1
  for (const name of Object.keys(services)) {
    if (services[name]?.shared) continue
    const dir = repoDir(name)
    if ((cwd === dir || cwd.startsWith(dir + path.sep)) && dir.length > bestLen) {
      best = name
      bestLen = dir.length
    }
  }
  return best
}

export function suggestStack(session: TAgentSession, state: TDevctlState): string | null {
  for (const [name, def] of Object.entries(state.stackDefs ?? {})) {
    for (const [repo, target] of Object.entries(def.services ?? {})) {
      if (target === 'test' || target === 'prod') continue
      let wt: ReturnType<typeof listWorktrees>[number] | undefined
      try {
        wt = listWorktrees(repo).find((tree) => tree.name === target)
      } catch {
        continue
      }
      if (!wt) continue
      if (session.cwd && (session.cwd === wt.path || session.cwd.startsWith(wt.path + path.sep))) return name
      if (wt.branch && session.branches.includes(wt.branch)) return name
    }
  }
  return null
}

export interface TRefreshResult {
  total: number
  added: number
  updated: number
  archived: number
}

export function refreshSessions(state: TDevctlState): TRefreshResult {
  const list = allSessions()
  const now = new Date().toISOString()
  const agents: Record<string, TAgentSession> = { ...(state.agents ?? {}) }
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  for (const session of list) {
    const key = sessionKey(session)
    seen.add(key)
    const prev = agents[key]
    if (prev) updated++
    else added++
    agents[key] = { ...session, note: prev?.note, lastSeen: now, state: 'active' }
  }
  let archived = 0
  for (const [key, session] of Object.entries(agents)) {
    if (!seen.has(key) && session.state !== 'archived') {
      agents[key] = { ...session, state: 'archived' }
      archived++
    }
  }
  state.agents = agents
  return { total: list.length, added, updated, archived }
}
