import fs from 'fs'
import { appendRecords, DEVCTL_DIR, migrateLegacyState, readRecords, rewriteRecords, STATE_FILE, storeWarn } from './store'
import type { TAgentSession } from './agents/types'

export { DEVCTL_DIR, STATE_FILE }
export { reportStoreWarnings } from './store'

export const STATE_VERSION = 3

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
  port: number | null
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
  agents?: Record<string, TAgentSession>
  links?: Record<string, string>
}

const NAMESPACES = ['stacks', 'targets', 'stackDefs', 'slots', 'agents', 'links'] as const
const META_KEYS = ['env', 'portless'] as const

interface TBaseline {
  meta: Record<string, unknown>
  ns: Record<string, Record<string, unknown>>
}

const baselines = new WeakMap<object, string>()

const MAX_LOG_BYTES = 256 * 1024

function emptyState(): TDevctlState {
  return { version: STATE_VERSION, stacks: {}, env: 'test', targets: {}, stackDefs: {}, slots: {} }
}

function serialize(state: TDevctlState): TBaseline {
  const bag = state as unknown as Record<string, unknown>
  const ns: Record<string, Record<string, unknown>> = {}
  for (const name of NAMESPACES) ns[name] = (bag[name] ?? {}) as Record<string, unknown>
  return { meta: { env: state.env, portless: state.portless, version: state.version }, ns }
}

function fold(records: unknown[]): TDevctlState {
  let state = emptyState()
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const event = record as { op?: string; ns?: string; key?: string; val?: unknown }
    const bag = state as unknown as Record<string, Record<string, unknown>>
    if (event.op === 'snapshot') {
      if (event.val && typeof event.val === 'object') {
        state = normalize({ ...emptyState(), ...(event.val as Partial<TDevctlState>) })
      }
      continue
    }
    if (event.op === 'meta' && typeof event.key === 'string') {
      ;(state as unknown as Record<string, unknown>)[event.key] = event.val
      continue
    }
    if ((event.op === 'put' || event.op === 'del') && typeof event.ns === 'string' && typeof event.key === 'string') {
      const ns = bag[event.ns] ?? {}
      if (event.op === 'put') ns[event.key] = event.val
      else delete ns[event.key]
      bag[event.ns] = ns
    }
  }
  return normalize(state)
}

function diff(state: TDevctlState, beforeRaw: string | undefined): unknown[] {
  const after = serialize(state)
  const before: TBaseline = beforeRaw ? (JSON.parse(beforeRaw) as TBaseline) : { meta: {}, ns: {} }
  const records: unknown[] = []
  for (const key of META_KEYS) {
    const next = after.meta[key]
    if (JSON.stringify(next) !== JSON.stringify(before.meta[key]) && next !== undefined) {
      records.push({ op: 'meta', key, val: next })
    }
  }
  for (const name of NAMESPACES) {
    const next = after.ns[name] ?? {}
    const prev = before.ns[name] ?? {}
    for (const key of Object.keys(next)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) records.push({ op: 'put', ns: name, key, val: next[key] })
    }
    for (const key of Object.keys(prev)) {
      if (!(key in next)) records.push({ op: 'del', ns: name, key })
    }
  }
  return records
}

function compactIfNeeded(state: TDevctlState): void {
  try {
    if (fsSize(STATE_FILE) <= MAX_LOG_BYTES) return
    rewriteRecords([{ op: 'snapshot', val: state }])
  } catch (error) {
    storeWarn(`could not compact ${STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let cache: { key: string; state: TDevctlState } | null = null

function fileKey(): string {
  try {
    const stat = fs.statSync(STATE_FILE)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

export function loadState(): TDevctlState {
  migrateLegacyState()
  const key = fileKey()
  if (cache && cache.key === key) {
    const state = JSON.parse(JSON.stringify(cache.state)) as TDevctlState
    baselines.set(state, JSON.stringify(serialize(state)))
    return state
  }
  const state = fold(readRecords())
  cache = { key: fileKey(), state: JSON.parse(JSON.stringify(state)) as TDevctlState }
  baselines.set(state, JSON.stringify(serialize(state)))
  return state
}

export function saveState(state: TDevctlState = loadState()): void {
  const before = baselines.get(state)
  appendRecords(diff(state, before))
  baselines.set(state, JSON.stringify(serialize(state)))
  cache = null
  compactIfNeeded(state)
}

function fsSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
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
    const id = `${entry.repo}:${entry.port ?? 'null'}`
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
    agents: state.agents ?? {},
    links: state.links ?? {},
  }
}
