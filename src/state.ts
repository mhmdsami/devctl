import fs from 'fs'
import os from 'os'
import path from 'path'

export const DEVCTL_DIR = process.env.DEVCTL_DIR ?? path.join(os.homedir(), '.devctl')
export const STATE_FILE = path.join(DEVCTL_DIR, 'state.json')
export const STATE_VERSION = 2

export interface TProcRef {
  workspaceId?: string
  tabId?: string
  paneId?: string
  pid?: number
  startToken?: string
  logFile?: string
  logOffset?: number
  port: number
}

export interface TStackState {
  key: string
  repo: string
  worktree: string
  branch: string | null
  ref: TProcRef
  port: number
  url: string
  portlessName?: string
  stack?: string
  wiring?: string
  startedAt: string
}

export interface TStackDef {
  name: string
  label?: string
  services: Partial<Record<string, string>>
}

export interface TDevctlState {
  version: number
  stacks: Record<string, TStackState>
  env: 'test' | 'prod'
  targets: Record<string, string>
  stackDefs: Record<string, TStackDef>
  slots: Record<string, number>
  portless?: boolean
}

function emptyState(): TDevctlState {
  return { version: STATE_VERSION, stacks: {}, env: 'test', targets: {}, stackDefs: {}, slots: {} }
}

export function loadState(): TDevctlState {
  try {
    return normalize(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as TDevctlState)
  } catch {
    return emptyState()
  }
}

function normalize(state: TDevctlState & { payloadTargets?: Record<string, string> }): TDevctlState {
  for (const def of Object.values(state.stackDefs ?? {})) {
    for (const [svc, target] of Object.entries(def.services ?? {})) {
      if (target === 'main') def.services[svc] = 'head'
    }
  }
  for (const [mapKey, entry] of Object.entries(state.stacks ?? {})) {
    if (entry.branch !== null) continue
    if (!mapKey.endsWith('/main') && entry.worktree !== 'main' && !entry.key.endsWith('/main')) continue
    entry.worktree = 'head'
    const base = (mapKey.endsWith('/main') ? mapKey : entry.key).slice(0, -'/main'.length)
    const newKey = `${base}/head`
    const existing = state.stacks[newKey]
    if (!existing || existing.startedAt < entry.startedAt) state.stacks[newKey] = { ...entry, key: newKey }
    if (mapKey !== newKey) delete state.stacks[mapKey]
  }
  const seen = new Map<string, { key: string; startedAt: string }>()
  for (const [mapKey, entry] of Object.entries(state.stacks ?? {})) {
    const id = `${entry.repo}:${entry.port}`
    const prev = seen.get(id)
    if (!prev) {
      seen.set(id, { key: mapKey, startedAt: entry.startedAt ?? '' })
      continue
    }
    const [keepKey, dropKey] = (entry.startedAt ?? '') > prev.startedAt ? [mapKey, prev.key] : [prev.key, mapKey]
    if (keepKey === mapKey) seen.set(id, { key: mapKey, startedAt: entry.startedAt ?? '' })
    delete state.stacks[dropKey]
  }
  return {
    version: STATE_VERSION,
    stacks: state.stacks ?? {},
    env: state.env ?? 'test',
    targets: state.targets ?? state.payloadTargets ?? {},
    stackDefs: state.stackDefs ?? {},
    slots: state.slots ?? {},
    portless: state.portless,
  }
}

export function saveState(state: TDevctlState = loadState()): void {
  fs.mkdirSync(DEVCTL_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}
