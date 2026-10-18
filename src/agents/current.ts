import { allSessions } from './index'
import type { TAgentSession } from './types'

export interface TCurrentSession {
  agent: string
  id: string
  source: 'env' | 'inferred'
}

export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENCODE === '1' || env.AI_AGENT === 'opencode') return 'opencode'
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) return 'claude'
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return 'codex'
  if (env.PI_AGENT_DIR || env.PI_HOME) return 'pi'
  return null
}

export function detectSessionId(agent: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (agent === 'opencode') return env.OPENCODE_SESSION_ID ?? null
  if (agent === 'claude') return env.CLAUDE_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID ?? null
  return null
}

export function inferSession(agent: string | null, cwd: string, sessions: TAgentSession[]): TAgentSession | null {
  const candidates = sessions.filter((session) => !agent || session.agent === agent)
  const under = candidates.filter((session) => session.cwd && (cwd === session.cwd || cwd.startsWith(session.cwd + '/') || session.cwd.startsWith(cwd + '/')))
  const pool = under.length > 0 ? under : candidates
  return pool.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null
}

export function resolveCurrentSession(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; sessions?: TAgentSession[] } = {},
): TCurrentSession | null {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const agent = detectAgent(env)
  const id = agent ? detectSessionId(agent, env) : null
  if (agent && id) return { agent, id, source: 'env' }
  const sessions = opts.sessions ?? allSessions()
  const inferred = inferSession(agent, cwd, sessions)
  if (!inferred) return null
  return { agent: inferred.agent, id: inferred.id, source: 'inferred' }
}
