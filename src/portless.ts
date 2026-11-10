import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { shQuote, tcpAlive } from './process'

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.portless')

function stateDir(): string {
  return process.env.PORTLESS_STATE_DIR ?? DEFAULT_STATE_DIR
}

function proxyPortFile(): string {
  return path.join(stateDir(), 'proxy.port')
}

export function caFile(): string {
  return path.join(stateDir(), 'ca.pem')
}
export const DEVCTL_PROXY_PORT = 1355

export interface TPortlessStateIssue {
  name: string
  status: 'error'
  detail: string
}

function shortList(paths: string[], limit = 4): string {
  const names = paths.map((entry) => path.basename(entry))
  if (names.length <= limit) return names.join(', ')
  return `${names.slice(0, limit).join(', ')}, +${names.length - limit} more`
}

export function auditPortlessState(dir = stateDir(), uid = process.getuid?.() ?? 0): TPortlessStateIssue[] {
  const issues: TPortlessStateIssue[] = []
  if (!fs.existsSync(dir)) return issues
  const files: string[] = []
  const collect = (folder: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile()) files.push(path.join(folder, entry.name))
    }
  }
  collect(dir)
  const hostCerts = path.join(dir, 'host-certs')
  if (fs.existsSync(hostCerts)) collect(hostCerts)
  const owned = [dir, hostCerts, ...files].filter((entry) => {
    try {
      return fs.statSync(entry).uid !== uid
    } catch {
      return false
    }
  })
  const caSrl = path.join(dir, 'ca.srl')
  const caSrlForeign = owned.includes(caSrl)
  let caSrlWritable = false
  try {
    fs.accessSync(caSrl, fs.constants.W_OK)
    caSrlWritable = true
  } catch {}
  if (owned.length > 0) {
    issues.push({
      name: 'portless:owner',
      status: 'error',
      detail: `${owned.length} path(s) not owned by you: ${shortList(owned)}${caSrlForeign && !caSrlWritable ? '; ca.srl is not writable, so certificate signing fails' : ''}. Fix: sudo chown -R $(id -u):$(id -g) ${shQuote(dir)}`,
    })
  } else if (fs.existsSync(caSrl) && !caSrlWritable) {
    issues.push({
      name: 'portless:ca-srl',
      status: 'error',
      detail: `${caSrl} is not writable, so certificate signing fails. Fix: chmod u+w ${shQuote(caSrl)}`,
    })
  }
  const empty = files.filter((entry) => {
    if (!entry.endsWith('.pem')) return false
    try {
      return fs.statSync(entry).size === 0
    } catch {
      return false
    }
  })
  if (empty.length > 0) {
    issues.push({
      name: 'portless:certs',
      status: 'error',
      detail: `${empty.length} empty certificate(s): ${shortList(empty)}. Fix: after fixing ownership, remove them and restart the proxy: rm ${empty.map(shQuote).join(' ')} && devctl portless stop && devctl portless start`,
    })
  }
  return issues
}

let cachedBin: string | null | undefined
let cachedRunnable: boolean | undefined

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function portlessBin(): string | null {
  if (cachedBin !== undefined) return cachedBin
  const local = path.join(packageRoot(), 'node_modules', '.bin', 'portless')
  if (fs.existsSync(local)) {
    cachedBin = local
    return cachedBin
  }
  try {
    cachedBin = execFileSync('bash', ['-lc', 'command -v portless'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null
  } catch {
    cachedBin = null
  }
  return cachedBin
}

export function portlessAvailable(): boolean {
  if (portlessBin() === null) return false
  if (cachedRunnable !== undefined) return cachedRunnable
  try {
    execFileSync(portlessBin()!, ['--version'], { stdio: 'ignore', timeout: 5_000 })
    cachedRunnable = true
  } catch {
    cachedRunnable = false
  }
  return cachedRunnable
}

export function requirePortless(): string {
  const bin = portlessBin()
  if (!bin || !portlessAvailable()) {
    throw new Error('portless is required but not usable - run `pnpm install` in the devctl checkout (needs Node 24+)')
  }
  return bin
}

export function proxyPort(): number {
  try {
    const value = Number(fs.readFileSync(proxyPortFile(), 'utf8').trim())
    if (Number.isInteger(value) && value > 0) return value
  } catch {
  }
  return 443
}

export function namedUrl(name: string): string {
  const port = proxyPort()
  return port === 443 ? `https://${name}.localhost` : `https://${name}.localhost:${port}`
}

export function portlessRunCommand(name: string, command: string): string {
  const bin = requirePortless()
  return `${shQuote(bin)} run --name ${shQuote(name)} bash -lc ${shQuote(command)}`
}

export async function portlessProxyUp(): Promise<boolean> {
  const port = proxyPort()
  return (await tcpAlive(port, 250)) || (await tcpAlive(DEVCTL_PROXY_PORT, 250))
}

export interface TRoute {
  host: string
  port: number
  kind: string
}

export function parseRoutesOutput(out: string): TRoute[] {
  const routes: TRoute[] = []
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '')
  for (const match of clean.matchAll(/https?:\/\/([^\s:]+)(?::\d+)?\s+->\s+localhost:(\d+)(?:\s+\(([^)]+)\))?/g)) {
    routes.push({ host: match[1], port: Number(match[2]), kind: match[3] ?? 'app' })
  }
  return routes
}

let cachedRoutes: TRoute[] | null = null
let cachedRoutesAt = 0
const ROUTES_TTL_MS = 1_000

export function invalidateRoutes(): void {
  cachedRoutes = null
  cachedRoutesAt = 0
}

export function listRoutes(): TRoute[] {
  const now = Date.now()
  if (cachedRoutes !== null && now - cachedRoutesAt < ROUTES_TTL_MS) return cachedRoutes
  const bin = portlessBin()
  if (!bin) {
    cachedRoutes = []
    cachedRoutesAt = now
    return cachedRoutes
  }
  try {
    const out = execFileSync(bin, ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
    cachedRoutes = parseRoutesOutput(out)
  } catch {
    cachedRoutes = []
  }
  cachedRoutesAt = now
  return cachedRoutes
}

export function routePort(name: string): number | null {
  const route = listRoutes().find((r) => r.host === `${name}.localhost`)
  return route?.port ?? null
}

export function activeRoutes(): Set<string> {
  return new Set(listRoutes().map((r) => r.host))
}

export function hasRoute(hostname: string): boolean {
  return activeRoutes().has(hostname)
}

export function alias(name: string, port: number): boolean {
  const bin = portlessBin()
  if (!bin) return false
  try {
    execFileSync(bin, ['alias', name, String(port)], { stdio: 'ignore', timeout: 10_000 })
    invalidateRoutes()
    return true
  } catch {
    return false
  }
}

export function removeAlias(name: string): boolean {
  const bin = portlessBin()
  if (!bin) return false
  try {
    execFileSync(bin, ['alias', '--remove', name], { stdio: 'ignore', timeout: 10_000 })
    invalidateRoutes()
    return true
  } catch {
    return false
  }
}

export function startProxy(port = proxyPort()): void {
  const bin = requirePortless()
  const args = ['proxy', 'start']
  if (port && port !== 443) args.push('-p', String(port))
  execFileSync(bin, args, { stdio: ['inherit', process.stderr, process.stderr], timeout: 30_000 })
}

export async function ensureProxy(): Promise<void> {
  const port = proxyPort()
  if (await tcpAlive(port, 250)) return
  startProxy(port === 443 ? DEVCTL_PROXY_PORT : port)
}

export function stopProxy(): void {
  const bin = portlessBin()
  if (!bin) return
  execFileSync(bin, ['proxy', 'stop'], { stdio: ['inherit', process.stderr, process.stderr], timeout: 30_000 })
}

function sanitizeLabel(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

/** portless prepends a linked worktree's branch itself, so it gets only the service part of the name. */
export function portlessRunName(repo: string, wt: { name: string; branch: string | null; path: string }, root: string): string {
  const prefixed = wt.path !== root && wt.branch !== null && wt.branch !== 'main' && wt.branch !== 'master'
  return prefixed ? repo : dnsName(repo, wt)
}

export function dnsName(repo: string, wt: { name: string; branch: string | null }): string {
  const label = wt.branch ?? wt.name
  if (label === 'main' || label === 'master') return repo
  return `${sanitizeLabel(label)}.${repo}`
}
