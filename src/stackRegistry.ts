import { listAllWorktrees, listWorktrees, repoKeys, type TRepoKey } from './registry'
import type { TStackDef } from './state'

function memberFor(stackName: string, repo: TRepoKey): string | undefined {
  const trees = listWorktrees(repo)
  return trees.find((t) => t.name === stackName)?.name
}

export function discoverStacks(): TStackDef[] {
  const names = new Set<string>()
  for (const t of listAllWorktrees()) {
    if (t.name !== 'head') names.add(t.name)
  }
  const defs: TStackDef[] = []
  for (const name of names) {
    const services: Partial<Record<TRepoKey, string>> = {}
    for (const repo of repoKeys()) {
      const m = memberFor(name, repo)
      if (m) services[repo] = m
    }
    if (Object.keys(services).length > 0) defs.push({ name, services })
  }
  return defs.sort((a, b) => a.name.localeCompare(b.name))
}

export function resolveStack(name: string, stackDefs: Record<string, TStackDef>): TStackDef {
  const saved = stackDefs[name]
  if (saved) return saved
  const found = discoverStacks().find((s) => s.name === name)
  if (found) return found
  throw new Error(
    `No stack "${name}". Run \`devctl stack ls\` - stacks are branch names shared across repos, or pin members with \`devctl stack add\`.`,
  )
}

export interface TStackDeletePlan {
  stop: string[]
  untag: string[]
}

export function stackDeletePlan(
  stacks: Record<string, { repo: string; stack?: string }>,
  name: string,
  pinnedKeys: string[],
  isSharedRepo: (repo: string) => boolean,
): TStackDeletePlan {
  const stop = new Set<string>()
  for (const key of pinnedKeys) if (stacks[key]) stop.add(key)
  const untag: string[] = []
  for (const [key, entry] of Object.entries(stacks)) {
    if (entry.stack !== name) continue
    if (isSharedRepo(entry.repo)) untag.push(key)
    else stop.add(key)
  }
  return { stop: [...stop], untag }
}
