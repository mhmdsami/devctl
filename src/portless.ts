import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { shQuote, tcpAlive } from './process'

const PROXY_PORT_FILE = path.join(os.homedir(), '.portless', 'proxy.port')
export const DEVCTL_PROXY_PORT = 1355

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
    const value = Number(fs.readFileSync(PROXY_PORT_FILE, 'utf8').trim())
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

export function listRoutes(): TRoute[] {
  const routes: TRoute[] = []
  const bin = portlessBin()
  if (bin) {
    try {
      const out = execFileSync(bin, ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
      for (const match of out.matchAll(/https?:\/\/(\S+)\s+->\s+localhost:(\d+)(?:\s+\(([^)]+)\))?/g)) {
        routes.push({ host: match[1], port: Number(match[2]), kind: match[3] ?? 'app' })
      }
    } catch {
    }
  }
  return routes
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

export function dnsName(repo: string, wt: { name: string; branch: string | null }): string {
  const label = wt.branch ?? wt.name
  if (label === 'main' || label === 'master') return repo
  return `${sanitizeLabel(label)}.${repo}`
}
