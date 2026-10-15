import fs from 'fs'
import path from 'path'
import { parseEnvFile, seedEnvFiles, writeEnvOverlay } from './envfile'
import { interpolate, loadConfig, repoDir, type TDevctlConfig, type TServiceConfig } from './config'
import { isShared, listWorktrees, type TRepoKey, type TWorktree } from './registry'
import { dnsName as portlessDnsName, namedUrl, namedUrlsEnabled } from './portless'
import { readOverrides } from './envOverrides'
import type { TDevctlState, TStackDef } from './state'

type TModeState = Pick<TDevctlState, 'env' | 'targets'> & { portless?: boolean }

function templateVars(repo: TRepoKey, wt: TWorktree, named: boolean): Record<string, string | number> {
  const name = portlessDnsName(repo, wt)
  const origin = named ? namedUrl(name) : `http://localhost:${wt.port}`
  return {
    port: wt.port,
    inspectPort: wt.inspectPort ?? '',
    dnsName: name,
    portlessUrl: origin,
    origin,
  }
}

export interface TStackPlan {
  path: string
  port: number
  cmd: string
  env: Record<string, string>
  healthTimeoutMs: number
  healthCommand?: string
}

export type TTarget = { kind: 'local'; name: string } | { kind: 'remote'; mode: 'test' | 'prod' }

export function serviceOf(repo: TRepoKey): TServiceConfig {
  const svc = loadConfig().services[repo]
  if (!svc) throw new Error(`service "${repo}" not in config`)
  return svc
}

export function providersOf(repo: TRepoKey): string[] {
  const svc = serviceOf(repo)
  const out = new Set<string>()
  for (const ref of Object.values(svc.wiring ?? {})) out.add(ref.split('.', 2)[0])
  for (const d of svc.dependsOn ?? []) out.add(d)
  return [...out]
}

export function dependentsOf(service: string): string[] {
  const cfg = loadConfig()
  return Object.entries(cfg.services)
    .filter(([, svc]) => providersOfSvc(svc).includes(service))
    .map(([name]) => name)
}

function providersOfSvc(svc: TServiceConfig): string[] {
  const out = new Set<string>()
  for (const ref of Object.values(svc.wiring ?? {})) out.add(ref.split('.', 2)[0])
  for (const d of svc.dependsOn ?? []) out.add(d)
  return [...out]
}

export function hasWiring(repo: TRepoKey): boolean {
  const svc = serviceOf(repo)
  return Boolean(svc.wiring && Object.keys(svc.wiring).length > 0)
}

function normalizeTarget(provider: string, raw: string): string {
  const prefix = `${provider}/`
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
}

export function targetFor(
  state: Pick<TDevctlState, 'env' | 'targets'>,
  consumer: string,
  provider: string,
  stackDef?: TStackDef,
): TTarget {
  const raw = stackDef?.services[provider] ?? state.targets[consumer] ?? state.env
  if (raw === 'test' || raw === 'prod') return { kind: 'remote', mode: raw }
  return { kind: 'local', name: normalizeTarget(provider, raw) }
}

function expandVarsLocal(map: Record<string, string>): Record<string, string> {
  const out = { ...map }
  for (let pass = 0; pass < 10; pass++) {
    let changed = false
    for (const [key, value] of Object.entries(out)) {
      const expanded = value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (whole, a, b) => {
        const ref = out[a ?? b]
        if (ref === undefined) return whole
        changed = true
        return ref
      })
      if (expanded !== value) out[key] = expanded
    }
    if (!changed) break
  }
  return out
}

function remoteValue(cfg: TDevctlConfig, mode: 'test' | 'prod', provider: string, value: string): string | null {
  const rs = serviceOf(provider).remoteProvides?.[value]
  if (!rs) return null
  const envFile = path.join(repoDir(rs.from), cfg.envBaseFiles[mode])
  const expanded = expandVarsLocal(parseEnvFile(fs.readFileSync(envFile, 'utf8')))
  return expanded[rs.envKey] ?? null
}

export function resolveWiring(
  state: TModeState,
  consumer: string,
  stackDef?: TStackDef,
): Record<string, string | null> {
  const cfg = loadConfig()
  const svc = serviceOf(consumer)
  const values: Record<string, string | null> = {}
  for (const [envKey, ref] of Object.entries(svc.wiring ?? {})) {
    const [provider, value] = ref.split('.', 2) as [string, string]
    const target = targetFor(state, consumer, provider, stackDef)
    if (target.kind === 'remote') {
      values[envKey] = remoteValue(cfg, target.mode, provider, value)
      continue
    }
    const wt = listWorktrees(provider).find((w) => w.name === target.name)
    if (!wt) throw new Error(`No ${provider} worktree for "${target.name}"`)
    const template = serviceOf(provider).provides?.[value]
    values[envKey] = template ? interpolate(template, templateVars(provider, wt, namedUrlsEnabled(state))) : null
  }
  return values
}

export type TDep = { kind: 'service'; repo: TRepoKey; worktree: string | null }
export function depsOf(
  state: Pick<TDevctlState, 'env' | 'targets'>,
  repo: TRepoKey,
  stackDef?: TStackDef,
): TDep[] {
  const deps: TDep[] = []
  for (const provider of providersOf(repo)) {
    if (isShared(provider)) {
      deps.push({ kind: 'service', repo: provider, worktree: null })
      continue
    }
    const target = targetFor(state, repo, provider, stackDef)
    if (target.kind === 'local') deps.push({ kind: 'service', repo: provider, worktree: target.name })
  }
  return deps
}

export function planStack(
  repo: TRepoKey,
  wt: TWorktree,
  state: TModeState,
  stackDef?: TStackDef,
): TStackPlan {
  const svc = serviceOf(repo)
  if (!svc.shared) seedEnvFiles(wt.path, repoDir(repo))
  const vars = templateVars(repo, wt, namedUrlsEnabled(state))
  const { env } = resolveEnv(repo, wt, state, stackDef, { write: true })
  return {
    path: wt.path,
    port: wt.port,
    cmd: interpolate(svc.command, vars),
    env,
    healthTimeoutMs: svc.healthTimeoutMs,
    healthCommand: svc.healthCommand,
  }
}

export interface TEnvSource {
  value: string
  source: string
}

export interface TEnvResolution {
  env: Record<string, string>
  display: Record<string, TEnvSource>
}

export function resolveEnv(
  repo: TRepoKey,
  wt: TWorktree,
  state: TModeState,
  stackDef?: TStackDef,
  opts: { write?: boolean } = {},
): TEnvResolution {
  const cfg = loadConfig()
  const svc = serviceOf(repo)
  const vars = templateVars(repo, wt, namedUrlsEnabled(state))
  const baseFile = cfg.envBaseFiles[state.env]
  const basePath = path.join(wt.path, baseFile)
  const base: Record<string, string> = !svc.shared && fs.existsSync(basePath) ? parseEnvFile(fs.readFileSync(basePath, 'utf8')) : {}

  const display: Record<string, TEnvSource> = {}
  for (const [key, value] of Object.entries(base)) display[key] = { value, source: `base ${baseFile}` }

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(svc.env ?? {})) {
    const resolved = interpolate(value, vars)
    env[key] = resolved
    display[key] = { value: resolved, source: `services.${repo}.env` }
  }

  const externals = svc.envExternals?.[state.env]
  if (externals) {
    for (const [key, value] of Object.entries(externals)) {
      env[key] = value
      display[key] = { value, source: `envExternals.${state.env}` }
    }
  }

  const wiring = svc.wiring ?? {}
  if (!svc.shared && Object.keys(wiring).length > 0) {
    const values = resolveWiring(state, repo, stackDef)
    const overrides: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) overrides[key] = value
      display[key] = { value: value ?? '', source: `wiring ${wiring[key] ?? ''}` }
    }
    const merged = { ...base, ...overrides }
    if (opts.write) writeEnvOverlay(wt.path, baseFile, overrides)
    for (const [key, value] of Object.entries(merged)) {
      const current = display[key]
      if (!current || current.source.startsWith('base')) {
        display[key] = { value, source: `overlay .env.local (${wiring[key] ? `wiring ${wiring[key]}` : 'base'})` }
      }
    }
    for (const key of svc.overlayManagedKeys ?? []) {
      if (merged[key] !== undefined) {
        env[key] = merged[key]
        display[key] = { value: merged[key], source: `overlay .env.local (${wiring[key] ? `wiring ${wiring[key]}` : 'base'})` }
      }
    }
  }

  const overrides = readOverrides(stackDef?.name, repo)
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value
    display[key] = { value, source: `override ${stackDef?.name}/${repo}.env` }
  }

  return { env, display }
}
