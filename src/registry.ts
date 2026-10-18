import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { LEGACY_WORKTREES_REL, loadConfig, repoPath, usesFixedPort, worktreePath } from './config'
import { loadState, saveState } from './state'

export type TRepoKey = string

export function repoKeys(): TRepoKey[] {
  return Object.keys(loadConfig().services)
}

function repoDir(repo: TRepoKey): string {
  return repoPath(loadConfig(), repo)
}

export interface TWorktree {
  repo: TRepoKey
  name: string
  branch: string | null
  path: string
  slot: number
  port: number | null
  inspectPort: number | null
}

export const SLOT_GAP = 9

export function slotPort(basePort: number, slot: number): number {
  return basePort + (slot === 0 ? 0 : SLOT_GAP + slot)
}

export function assignSlots(
  keys: string[],
  runningPorts: Record<string, number>,
  persisted: Record<string, number>,
  basePort: number,
): Record<string, number> {
  const slots: Record<string, number> = {}
  const used = new Set<number>()
  for (const key of keys) {
    const running = runningPorts[key]
    if (running === undefined) continue
    const derived = running - basePort - SLOT_GAP
    if (Number.isInteger(derived) && derived > 0 && !used.has(derived)) {
      slots[key] = derived
      used.add(derived)
    }
  }
  for (const key of keys) {
    if (slots[key] !== undefined) continue
    const known = persisted[key]
    if (known === 0 || (known !== undefined && known > 0 && !used.has(known))) {
      slots[key] = known
      used.add(known)
      continue
    }
  }
  for (const key of keys) {
    if (slots[key] !== undefined) continue
    let slot = key === keys[0] ? 0 : 1
    if (slot === 1) while (used.has(slot)) slot++
    slots[key] = slot
    used.add(slot)
  }
  return slots
}

export function entryName(wt: TWorktree): string {
  return wt.branch ?? wt.name
}

export function entryKey(wt: TWorktree): string {
  const named = entryName(wt)
  if (named === wt.name) return `${wt.repo}/${named}`
  return `${wt.repo}/${named}/${wt.name}`
}

interface TParsedWorktree {
  path: string
  branch: string | null
}

const GIT_TIMEOUT_MS = 10_000

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
}

function parsePorcelain(out: string): TParsedWorktree[] {
  const trees: TParsedWorktree[] = []
  let current: TParsedWorktree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current)
      current = { path: line.slice('worktree '.length), branch: null }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length)
    }
  }
  if (current) trees.push(current)
  return trees
}

function cfgForRepo(repo: TRepoKey) {
  const svc = loadConfig().services[repo]
  if (!svc) throw new Error(`service "${repo}" not in config`)
  return svc
}

function migrateLegacyWorktree(root: string, wtPath: string): string {
  if (!wtPath.includes(`/${LEGACY_WORKTREES_REL}/`)) return wtPath
  const dirName = path.basename(wtPath)
  const dest = worktreePath(path.basename(root), dirName)
  if (fs.existsSync(dest)) return dest
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    git(root, ['worktree', 'move', wtPath, dest])
    console.error(`devctl: migrated worktree ${path.relative(root, wtPath)} → ${dest}`)
    return dest
  } catch (err) {
    console.error(`devctl: warning: failed to migrate ${wtPath}: ${err instanceof Error ? err.message : err}`)
    return wtPath
  }
}

export function listWorktrees(repo: TRepoKey): TWorktree[] {
  const svc = cfgForRepo(repo)
  if (svc.shared) {
    return [{ repo, name: 'head', branch: null, path: repoDir(repo), slot: 0, port: svc.basePort, inspectPort: svc.inspectBasePort ?? null }]
  }
  const root = repoDir(repo)
  const out = git(root, ['worktree', 'list', '--porcelain'])
  const parsed = parsePorcelain(out)
  const migrated = parsed.map((t) => (t.path !== root ? migrateLegacyWorktree(root, t.path) : t.path))
  const live = migrated.filter((p) => p === root || fs.existsSync(p))

  const linked = live
    .filter((p) => p !== root)
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))

  const ordered = [
    { tree: live.find((p) => p === root) ? { path: root, branch: null } : null, name: 'head' },
    ...linked.map((p) => ({ tree: { path: p, branch: parsed.find((t) => t.path === p)?.branch ?? null }, name: path.basename(p) })),
  ].filter((e) => e.tree) as Array<{ tree: { path: string; branch: string | null }; name: string }>

  const state = loadState()
  const keys = ordered.map((entry) => `${repo}/${entry.name}`)
  const runningPorts: Record<string, number> = {}
  for (const key of keys) {
    const tracked = state.stacks[key]
    if (tracked && tracked.port !== null) runningPorts[key] = tracked.port
  }
  const assigned = assignSlots(keys, runningPorts, state.slots ?? {}, svc.basePort)
  const merged = { ...(state.slots ?? {}), ...assigned }
  if (JSON.stringify(merged) !== JSON.stringify(state.slots ?? {})) {
    state.slots = merged
    saveState(state)
  }

  return ordered.map((entry) => {
    const slot = assigned[`${repo}/${entry.name}`] ?? 0
    return {
      repo,
      name: entry.name,
      branch: entry.tree.branch,
      path: entry.tree.path,
      slot,
      port: usesFixedPort(svc) ? slotPort(svc.basePort, slot) : null,
      inspectPort: svc.inspectBasePort != null ? svc.inspectBasePort + slot : null,
    }
  })
}

export function isShared(repo: TRepoKey): boolean {
  return Boolean(loadConfig().services[repo]?.shared)
}

export function listAllWorktrees(): TWorktree[] {
  return repoKeys().filter((repo) => !isShared(repo)).flatMap((repo) => listWorktrees(repo))
}

export function findWorktree(repo: TRepoKey, target: string): TWorktree {
  const trees = listWorktrees(repo)
  const found = trees.find((t) => t.name === target)
  if (!found) {
    const names = trees.map((t) => t.name).join(', ')
    throw new Error(`No worktree "${target}" in ${repo}. Targets are worktree names (or "head"), not branches. Available: ${names}`)
  }
  return found
}

export function resolveCwdTarget(): { repo: TRepoKey; worktree: TWorktree } | null {
  const cwd = process.cwd()
  for (const repo of repoKeys()) {
    if (cfgForRepo(repo).shared) continue
    const root = repoDir(repo)
    if (cwd === root || cwd.startsWith(root + path.sep)) {
      return { repo, worktree: listWorktrees(repo).find((t) => cwd === t.path || cwd.startsWith(t.path + path.sep))! }
    }
  }
  return null
}

export function createWorktree(repo: TRepoKey, branch: string): TWorktree {
  if (cfgForRepo(repo).shared) throw new Error(`"${repo}" is a shared service - it has no worktrees`)
  const existing = listWorktrees(repo).find((t) => t.branch === branch || t.name === branch)
  if (existing) return existing

  const root = repoDir(repo)
  const dirName = branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const wtPath = worktreePath(repo, dirName)

  let remoteHasBranch = false
  try {
    const out = git(root, ['ls-remote', '--heads', 'origin', branch])
    remoteHasBranch = out.trim().length > 0
  } catch {
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  const args = remoteHasBranch
    ? ['worktree', 'add', wtPath, branch]
    : ['worktree', 'add', '-b', branch, wtPath]
  git(root, args)

  return listWorktrees(repo).find((t) => t.branch === branch || t.name === dirName)!
}

export function removeWorktree(repo: TRepoKey, name: string, force = false): void {
  if (cfgForRepo(repo).shared) throw new Error(`"${repo}" is a shared service - it has no worktrees`)
  if (name === 'head') throw new Error(`refusing to remove "head" - that is the ${repo} checkout itself`)
  const wt = listWorktrees(repo).find((t) => t.name === name)
  if (!wt) return
  git(repoDir(repo), ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path])
  try {
    git(repoDir(repo), ['worktree', 'prune'])
  } catch {}
}

export function parseTarget(arg: string): { repo: TRepoKey; worktree: TWorktree } {
  const parts = arg.split('/')
  const [repo, name, ...extra] = parts
  if (!(repo in loadConfig().services)) {
    throw new Error(`Unknown repo "${repo}". Known: ${repoKeys().join(', ')}`)
  }
  if (extra.length > 0) {
    throw new Error(`Too many "/" segments in "${arg}" - expected <service>[/<branch-or-name>]`)
  }
  return { repo, worktree: findWorktree(repo, name ?? 'head') }
}
