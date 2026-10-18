import { getPreferenceValues } from '@raycast/api'
import { execFile, execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

interface Preferences {
  devctlPath: string
  editorApp?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const LONG_RUNNING_TIMEOUT_MS = 10 * 60_000

export interface TWorktreeInfo {
  repo: string
  name: string
  branch: string | null
  path: string
  index: number
  port: number | null
  inspectPort: number | null
}

export interface TStackRunningMember {
  key: string
  port: number | null
  url: string
  portlessName?: string
  ref?: { logFile?: string }
}

export interface TStackInfo {
  name: string
  label?: string
  services: Record<string, string>
  running: TStackRunningMember[]
  pinned: boolean
}

export interface TStackStatus {
  env: 'test' | 'prod'
  targets: Record<string, string>
  stacks: Array<
    TStackRunningMember & {
      repo: string
      worktree: string
      branch: string | null
      stack?: string
      stackLabel?: string
      startedAt: string
      alive: boolean
      listening: boolean
      portlessUrl: string | null
    }
  >
}

export interface TPortlessStatus {
  installed: boolean
  usable: boolean
  bin: string | null
  enabled: boolean
  proxyUp: boolean
  port: number
  routes: string[]
}

const BINARY_NAME = 'devctl'

let cachedLoginPath: string | null | undefined

function loginPath(): string | null {
  if (cachedLoginPath !== undefined) return cachedLoginPath
  try {
    const shell = process.env.SHELL ?? '/bin/zsh'
    cachedLoginPath = execFileSync(shell, ['-lic', 'printenv PATH'], { encoding: 'utf8', timeout: 5_000 }).trim() || null
  } catch {
    cachedLoginPath = null
  }
  return cachedLoginPath
}

function binaryDirs(): string[] {
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const entry of (loginPath() ?? process.env.PATH ?? '').split(':')) {
    if (entry) dirs.push(entry)
  }
  return [...new Set(dirs)]
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveBinary(): string | null {
  for (const dir of binaryDirs()) {
    const candidate = path.join(dir, BINARY_NAME)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function binaryPath(): string {
  const { devctlPath } = getPreferenceValues<Preferences>()
  const configured = devctlPath?.trim()
  if (configured) {
    const expanded = expandHome(configured)
    if (isExecutable(expanded)) return expanded
  }
  const resolved = resolveBinary()
  if (resolved) return resolved
  if (configured && !configured.includes('/')) return configured
  throw new Error('devctl not found. Install it, or set the "devctl Path" preference to the devctl executable.')
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: binaryDirs().join(':'),
  }
}

export function run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath(),
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: commandEnvironment() },
      (error, stdout, stderr) => {
        if (error) {
          const detail =
            stderr.trim() ||
            stdout
              .trim()
              .split('\n')
              .filter(Boolean)
              .slice(-10)
              .join('\n') ||
            error.message
          reject(new Error(detail))
          return
        }
        resolve(stdout)
      },
    )
  })
}

export function runLongCommand(args: string[]): Promise<string> {
  return run(args, LONG_RUNNING_TIMEOUT_MS)
}

export async function statusJson(): Promise<TStackStatus> {
  const parsed = JSON.parse(await run(['status', '--json'])) as Partial<TStackStatus>
  return { env: parsed.env ?? 'test', targets: parsed.targets ?? {}, stacks: Array.isArray(parsed.stacks) ? parsed.stacks : [] }
}

export async function stacksJson(): Promise<{ stacks: TStackInfo[] }> {
  const parsed = JSON.parse(await run(['stack', 'ls', '--json'])) as Partial<{ stacks: TStackInfo[] }>
  return { stacks: Array.isArray(parsed.stacks) ? parsed.stacks : [] }
}

export async function worktrees(): Promise<TWorktreeInfo[]> {
  const parsed = JSON.parse(await run(['which', '--json'])) as unknown
  return Array.isArray(parsed) ? (parsed as TWorktreeInfo[]) : []
}

export async function portlessStatusJson(): Promise<TPortlessStatus> {
  const parsed = JSON.parse(await run(['portless', 'status', '--json'])) as Partial<TPortlessStatus>
  return {
    installed: Boolean(parsed.installed),
    usable: Boolean(parsed.usable),
    bin: parsed.bin ?? null,
    enabled: Boolean(parsed.enabled),
    proxyUp: Boolean(parsed.proxyUp),
    port: typeof parsed.port === 'number' ? parsed.port : 443,
    routes: Array.isArray(parsed.routes) ? parsed.routes : [],
  }
}

export async function devctlVersion(): Promise<string> {
  return (await run(['--version'])).trim()
}

export interface TAgentSessionInfo {
  agent: string
  id: string
  title: string
  branch: string | null
  cwd: string
  repo: string | null
  link: string | null
  suggestion: string | null
  note: string | null
  updatedAt: string | null
  state: string
  resume: string[] | null
}

export async function agentSessions(stack?: string): Promise<TAgentSessionInfo[]> {
  const args = ['agents', '--json', ...(stack ? [stack] : [])]
  const parsed = JSON.parse(await run(args)) as Partial<{ sessions: TAgentSessionInfo[] }>
  return Array.isArray(parsed.sessions) ? parsed.sessions : []
}

export function serviceLogs(target: string, lines = 100): Promise<string> {
  return run(['logs', target, '--lines', String(lines)])
}

export function spawnDevctl(args: string[], onChunk?: (chunk: string) => void): { promise: Promise<number>; kill: () => void } {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(binaryPath(), args, { env: commandEnvironment() })
  } catch (error) {
    return { promise: Promise.reject(error), kill: () => {} }
  }
  const handle = (chunk: Buffer): void => onChunk?.(chunk.toString())
  child.stdout?.on('data', handle)
  child.stderr?.on('data', handle)
  const promise = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code: number | null) => resolve(code ?? 1))
  })
  const kill = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 3_000)
    timer.unref?.()
  }
  return { promise, kill }
}

function shellOut(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()))
  })
}

export async function worktreePathFor(repo: string, target: string): Promise<string | null> {
  const trees = await worktrees()
  const match = trees.find((t) => t.repo === repo && (t.branch === target || t.name === target))
  return match?.path ?? null
}

export function revealInFinder(path: string): Promise<void> {
  return shellOut('open', ['-R', path])
}

export function openInEditor(path: string): Promise<void> {
  const { editorApp } = getPreferenceValues<Preferences>()
  const app = editorApp?.trim() || 'Zed'
  const cli = `/Applications/${app}.app/Contents/MacOS/cli`
  if (fs.existsSync(cli)) return shellOut(cli, ['-n', path])
  return shellOut('open', ['-a', app, path])
}

function appleScriptShellString(value: string): string {
  const shellQuoted = `'${value.replaceAll("'", `'\\''`)}'`
  return shellQuoted.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export async function followLogsInTerminal(logFile: string): Promise<void> {
  await shellOut('osascript', ['-e', `tell application "Terminal" to do script "tail -n 100 -f ${appleScriptShellString(logFile)}"`])
}
