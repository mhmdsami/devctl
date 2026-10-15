import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { tcpAlive } from './process'

const PROXY_PORT_FILE = path.join(os.homedir(), '.portless', 'proxy.port')

let cachedBin: string | null | undefined
let cachedRunnable: boolean | undefined
let cachedRoutes: Set<string> | undefined

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
    cachedBin = execFileSync('bash', ['-lc', 'command -v portless'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    cachedBin = null
  }
  return cachedBin
}

export function portlessAvailable(): boolean {
  if (portlessBin() === null) return false
  if (cachedRunnable !== undefined) return cachedRunnable
  try {
    execFileSync(portlessBin()!, ['--version'], { stdio: 'ignore' })
    cachedRunnable = true
  } catch {
    cachedRunnable = false
  }
  return cachedRunnable
}

export function namedUrlsEnabled(state: { portless?: boolean }): boolean {
  if (state.portless === false) return false
  return portlessAvailable()
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

export async function portlessProxyUp(): Promise<boolean> {
  const port = proxyPort()
  return (await tcpAlive(port, 250)) || (await tcpAlive(1355, 250))
}

export function activeRoutes(): Set<string> {
  if (cachedRoutes) return cachedRoutes
  const routes = new Set<string>()
  const bin = portlessBin()
  if (bin) {
    try {
      const out = execFileSync(bin, ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const match of out.matchAll(/https?:\/\/([^\s/]+)/g)) routes.add(match[1])
    } catch {
    }
  }
  cachedRoutes = routes
  return routes
}

export function hasRoute(hostname: string): boolean {
  return activeRoutes().has(hostname)
}

export async function portlessUrl(name: string): Promise<string | null> {
  if (!portlessAvailable()) return null
  if (!(await portlessProxyUp())) return null
  if (!hasRoute(`${name}.localhost`)) return null
  return namedUrl(name)
}

export function alias(name: string, port: number): boolean {
  const bin = portlessBin()
  if (!bin) return false
  try {
    execFileSync(bin, ['alias', name, String(port)], { stdio: 'ignore' })
    cachedRoutes = undefined
    return true
  } catch {
    return false
  }
}

export function removeAlias(name: string): boolean {
  const bin = portlessBin()
  if (!bin) return false
  try {
    execFileSync(bin, ['alias', '--remove', name], { stdio: 'ignore' })
    cachedRoutes = undefined
    return true
  } catch {
    return false
  }
}

export function startProxy(port?: number): void {
  const bin = portlessBin()
  if (!bin) throw new Error('portless is not installed')
  const args = ['proxy', 'start']
  if (port && port !== 443) args.push('-p', String(port))
  execFileSync(bin, args, { stdio: ['inherit', process.stderr, process.stderr] })
}

export function stopProxy(): void {
  const bin = portlessBin()
  if (!bin) return
  execFileSync(bin, ['proxy', 'stop'], { stdio: ['inherit', process.stderr, process.stderr] })
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
