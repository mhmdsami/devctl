export interface TAgentSession {
  agent: string
  id: string
  cwd: string
  branches: string[]
  title: string
  path: string
  updatedAt: string | null
  note?: string
  lastSeen?: string
  state?: 'active' | 'archived'
}

export interface TAgentAdapter {
  kind: string
  list(): TAgentSession[]
  resume(session: TAgentSession): string[]
}
