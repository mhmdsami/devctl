import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseJsonc } from './jsonc'
import { validateConfig } from './validate'

export interface TRemoteSource {
  from: string
  envKey: string
}

export interface TServiceConfig {
  repo: string
  basePort: number
  inspectBasePort?: number
  command: string
  env: Record<string, string>
  envExternals?: Record<string, Record<string, string>>
  healthTimeoutMs: number
  healthCommand?: string
  shared?: boolean
  sidecar?: boolean
  stopCommand?: string
  logsCommand?: string
  install?: string
  provides?: Record<string, string>
  remoteProvides?: Record<string, TRemoteSource>
  wiring?: Record<string, string>
  dependsOn?: string[]
  overlayManagedKeys?: string[]
}

export interface TDebugConfig {
  enabled?: boolean
  command?: string
  provider?: string
  model?: string
}

export interface TDevctlConfig {
  version?: number
  reposRoot: string
  herdr: { enabled: boolean; workspace: string }
  envBaseFiles: Record<'local' | 'test' | 'prod', string>
  debug?: TDebugConfig
  services: Record<string, TServiceConfig>
}

export const WORKTREES_ROOT = process.env.DEVCTL_WORKTREES_ROOT ?? path.join(os.homedir(), 'dev', 'worktrees')
export const LEGACY_WORKTREES_REL = path.join('.claude', 'worktrees')

export function resolveConfigPath(): string {
  if (process.env.DEVCTL_CONFIG) return path.resolve(process.env.DEVCTL_CONFIG)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(here, '..')
  const jsonc = path.join(dir, 'devctl.config.jsonc')
  const json = path.join(dir, 'devctl.config.json')
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  throw new Error(`no devctl.config.{jsonc,json} found in ${dir}`)
}

export function loadConfig(): TDevctlConfig {
  const file = resolveConfigPath()
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = parseJsonc<unknown>(raw, file)
  expandHome(parsed)
  const cfg = validateConfig(parsed)
  cfg.version ??= CONFIG_VERSION
  return cfg
}

export const CONFIG_VERSION = 2

export function interpolate(template: string, vars: Record<string, string | number | null>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, key) => {
    const v = vars[key]
    return v === undefined || v === null ? whole : String(v)
  })
}

export function usesFixedPort(svc: TServiceConfig): boolean {
  const token = /\$\{port\}/
  if (token.test(svc.command)) return true
  for (const value of Object.values(svc.env ?? {})) if (token.test(value)) return true
  for (const value of Object.values(svc.provides ?? {})) if (token.test(value)) return true
  return false
}

export function repoPath(cfg: TDevctlConfig, service: string): string {
  const rel = cfg.services[service]?.repo
  if (!rel) throw new Error(`service "${service}" not in config`)
  return path.isAbsolute(rel) ? rel : path.join(cfg.reposRoot, rel)
}

export function repoDir(service: string): string {
  return repoPath(loadConfig(), service)
}

export function worktreePath(repo: string, branch: string): string {
  const dirName = branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return path.join(WORKTREES_ROOT, repo, dirName)
}

function expandHome(node: unknown): void {
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && v.startsWith('~/')) {
      ;(node as Record<string, unknown>)[k] = path.join(os.homedir(), v.slice(2))
    } else if (v && typeof v === 'object') {
      expandHome(v)
    }
  }
}
