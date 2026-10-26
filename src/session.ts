import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import { loadConfig } from './config'
import { envExports, killTree, ownedPidsOnPort, pidCwd, pidsListeningOnPort, processMatches, processStartToken, shQuote } from './process'
import { sleepSync } from './util'
import { tailFile } from './logtail'

export interface TProcRef {
  logOffset?: number
  workspaceId?: string
  tabId?: string
  paneId?: string
  pid?: number
  startToken?: string
  exitMarker?: string
  logFile?: string
  port: number
}

function herdrEnabled(): boolean {
  return loadConfig().herdr.enabled === true
}

const HERDR_TIMEOUT_MS = 15_000

function h(args: string[]): Record<string, unknown> {
  const out = execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: HERDR_TIMEOUT_MS })
  try {
    return JSON.parse(out) as Record<string, unknown>
  } catch {
    throw new Error(`herdr ${args[0]} ${args[1]} returned non-JSON: ${out.slice(0, 200)}`)
  }
}

function raw(args: string[]): void {
  execFileSync('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: HERDR_TIMEOUT_MS })
}

interface TWorkspaceRef {
  workspaceId: string
  placeholderTabId: string | null
}

function findHerdrWorkspace(label?: string): string | null {
  const wsLabel = label ?? loadConfig().herdr.workspace
  const res = h(['workspace', 'list']).result as { workspaces: Array<{ workspace_id: string; label: string }> }
  return res.workspaces.find((w) => w.label === wsLabel)?.workspace_id ?? null
}

function herdrWorkspaceId(label?: string): TWorkspaceRef {
  const existing = findHerdrWorkspace(label)
  if (existing) return { workspaceId: existing, placeholderTabId: null }
  const wsLabel = label ?? loadConfig().herdr.workspace
  const created = h(['workspace', 'create', '--label', wsLabel, '--cwd', process.env.HOME ?? '~']).result as {
    workspace: { workspace_id: string }
    tab: { tab_id: string }
  }
  return { workspaceId: created.workspace.workspace_id, placeholderTabId: created.tab.tab_id }
}

function discardPlaceholder(ref: TWorkspaceRef): void {
  if (!ref.placeholderTabId) return
  try {
    raw(['tab', 'close', ref.placeholderTabId])
  } catch {}
}

interface THerdrTab {
  tab_id: string
  label: string
}

function listTabs(workspaceId: string): THerdrTab[] {
  try {
    const res = h(['tab', 'list', '--workspace', workspaceId]).result as { tabs?: THerdrTab[] }
    return res.tabs ?? []
  } catch {
    return []
  }
}

function logFileFor(key: string): string {
  const dir = `${process.env.HOME}/.devctl/logs`
  fs.mkdirSync(dir, { recursive: true })
  return `${dir}/${key.replace(/\//g, '__')}.log`
}

export function start(
  key: string,
  cwd: string,
  env: Record<string, string>,
  command: string,
  port: number,
  workspaceLabel?: string,
  opts: { detached?: boolean } = {},
): TProcRef {
  const prefixed = `${envExports(env)}${command}`
  const logFile = logFileFor(key)
  const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
  if (herdrEnabled() && !opts.detached) {
    const ws = herdrWorkspaceId(workspaceLabel)
    const args = ['tab', 'create', '--workspace', ws.workspaceId, '--label', key, '--cwd', cwd]
    for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`)
    const res = h(args).result as { tab: { tab_id: string }; root_pane: { pane_id: string } }
    const exitMarker = `__DEVCTL_EXITED_${Date.now()}__`
    const teed = `{ ${prefixed}; } 2>&1 | tee -a ${shQuote(logFile)}; printf '%s\\n' '${exitMarker}' >> ${shQuote(logFile)}`
    execFileSync('herdr', ['pane', 'run', res.root_pane.pane_id, teed], { stdio: 'ignore', timeout: HERDR_TIMEOUT_MS })
    discardPlaceholder(ws)
    const shellPid = paneProcessInfo(res.root_pane.pane_id)?.shell_pid
    return {
      workspaceId: ws.workspaceId,
      tabId: res.tab.tab_id,
      paneId: res.root_pane.pane_id,
      pid: shellPid,
      startToken: shellPid ? processStartToken(shellPid) ?? undefined : undefined,
      exitMarker,
      logFile,
      logOffset,
      port,
    }
  }
  fs.appendFileSync(logFile, `\n===== devctl start ${new Date().toISOString()} =====\n$ ${command}\n\n`)
  const out = fs.openSync(logFile, 'a')
  const child = spawn('bash', ['-c', prefixed], { cwd, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  return {
    pid: child.pid!,
    startToken: processStartToken(child.pid!) ?? undefined,
    logFile,
    logOffset,
    port,
  }
}

export function rerunIn(ref: TProcRef, env: Record<string, string>, command: string): void {
  const prefixed = `${envExports(env)}${command}`
  if (ref.paneId) {
    const wrapped = ref.logFile ? `{ ${prefixed}; } 2>&1 | tee -a ${shQuote(ref.logFile)}` : prefixed
    execFileSync('herdr', ['pane', 'run', ref.paneId, wrapped], { stdio: 'ignore', timeout: HERDR_TIMEOUT_MS })
  }
}

export function refAlive(ref: TProcRef): boolean {
  if (herdrEnabled() && ref.tabId) {
    if (!ref.workspaceId) return false
    return listTabs(ref.workspaceId).some((t) => t.tab_id === ref.tabId)
  }
  if (ref.pid) {
    try {
      process.kill(ref.pid, 0)
      return true
    } catch {
      return false
    }
  }
  return false
}
export function refExited(ref: TProcRef): boolean {
  if (ref.exitMarker && ref.logFile && tailFile(ref.logFile, 30).includes(ref.exitMarker)) return true
  if (ref.pid && !ref.paneId) return !processMatches(ref.pid, ref.startToken)
  if (herdrEnabled() && ref.paneId) {
    const info = paneProcessInfo(ref.paneId)
    if (!info) return false
    return !processMatches(info.shell_pid)
  }
  return false
}

function paneIdForTab(tabId: string): string | null {
  try {
    const res = h(['pane', 'list']).result as { panes: Array<{ pane_id: string; tab_id: string }> }
    return res.panes.find((p) => p.tab_id === tabId)?.pane_id ?? null
  } catch {
    return null
  }
}

function paneProcessInfo(paneId: string): { shell_pid: number; foreground_process_group_id?: number } | null {
  try {
    const res = execFileSync('herdr', ['pane', 'process-info', '--pane', paneId], { encoding: 'utf8', timeout: HERDR_TIMEOUT_MS })
    const parsed = JSON.parse(res) as {
      result: { process_info: { shell_pid: number; foreground_process_group_id?: number } }
    }
    return parsed.result.process_info
  } catch {
    return null
  }
}

function killPaneTree(paneId: string): void {
  const info = paneProcessInfo(paneId)
  if (!info) return
  const { shell_pid, foreground_process_group_id } = info
  for (const gid of [foreground_process_group_id, shell_pid]) {
    if (!gid) continue
    try {
      process.kill(-gid, 'SIGTERM')
    } catch {}
    try {
      process.kill(gid, 'SIGTERM')
    } catch {}
  }
}

function closeTabsByLabel(workspaceId: string, label: string): void {
  for (const tab of listTabs(workspaceId)) {
    if (tab.label === label) {
      try {
        raw(['tab', 'close', tab.tab_id])
      } catch {}
    }
  }
}

export function stopRef(ref: TProcRef, label?: string, opts: { keepPort?: boolean; force?: boolean } = {}): void {
  if (herdrEnabled() && (ref.paneId || ref.tabId)) {
    const paneId = ref.paneId || (ref.tabId ? paneIdForTab(ref.tabId) : null)
    if (paneId) killPaneTree(paneId)
    if (ref.tabId) {
      try {
        raw(['tab', 'close', ref.tabId])
      } catch {}
    }
    if (label && ref.workspaceId) closeTabsByLabel(ref.workspaceId, label)
  }
  if (ref.pid) killTree(ref.pid, ref.startToken)
  if (opts.keepPort) return
  if (ref.pid) for (const pid of ownedPidsOnPort(ref.port, ref.pid, ref.startToken)) killTree(pid)
  let remaining = pidsListeningOnPort(ref.port)
  for (let i = 0; i < 20 && remaining.length > 0; i++) {
    sleepSync(500)
    remaining = pidsListeningOnPort(ref.port)
  }
  if (remaining.length === 0) return
  if (!opts.force) {
    throw new Error(
      `port ${ref.port} still in use by pid ${remaining.join(', ')} after stopping - not owned by this run; re-run with --force to kill it`,
    )
  }
  for (const pid of remaining) killTree(pid)
}

export function closeWorkspaceByLabel(label: string): boolean {
  if (!herdrEnabled()) return false
  const res = h(['workspace', 'list']).result as { workspaces: Array<{ workspace_id: string; label: string }> }
  const ws = res.workspaces.find((w) => w.label === label)
  if (!ws) return false
  raw(['workspace', 'close', ws.workspace_id])
  return true
}

export function sweepDevctlTabs(): number {
  if (!herdrEnabled()) return 0
  const wsId = findHerdrWorkspace()
  if (!wsId) return 0
  const servicePrefixes = Object.keys(loadConfig().services).map((s) => `${s}/`)
  let closed = 0
  for (const tab of listTabs(wsId)) {
    if (tab.label === 'scratch') continue
    if (servicePrefixes.some((p) => tab.label.startsWith(p))) {
      const paneId = paneIdForTab(tab.tab_id)
      if (paneId) killPaneTree(paneId)
      try {
        raw(['tab', 'close', tab.tab_id])
        closed++
      } catch {}
    }
  }
  return closed
}

export function refOutput(ref: TProcRef, lines = 30): string {
  if (ref.logFile && ref.logOffset !== undefined && ref.logOffset > 0 && fs.existsSync(ref.logFile)) {
    const size = fs.statSync(ref.logFile).size
    if (size > ref.logOffset) {
      const fd = fs.openSync(ref.logFile, 'r')
      const length = size - ref.logOffset
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, ref.logOffset)
      fs.closeSync(fd)
      const slice = buffer.toString('utf8').replace(/\n$/, '')
      return slice.split('\n').slice(-lines).join('\n')
    }
    return ''
  }
  if (ref.logFile) return tailFile(ref.logFile, lines)
  if (herdrEnabled() && ref.paneId) {
    try {
      const out = execFileSync(
        'herdr',
        ['pane', 'read', ref.paneId, '--source', 'visible', '--format', 'text', '--lines', String(lines)],
        { encoding: 'utf8' },
      )
      try {
        const parsed = JSON.parse(out) as { result: { text?: string; content?: string } }
        return parsed.result.text ?? parsed.result.content ?? out
      } catch {
        return out
      }
    } catch (err) {
      return `(pane read failed: ${err instanceof Error ? err.message : String(err)})`
    }
  }
  return '(no output source)'
}

export function focusWorkspace(label?: string): void {
  if (!herdrEnabled()) return
  const wsId = findHerdrWorkspace(label)
  if (!wsId) throw new Error(`no herdr workspace "${label ?? loadConfig().herdr.workspace}" - start a stack with devctl up first`)
  raw(['workspace', 'focus', wsId])
}

export function focusTab(ref: TProcRef): boolean {
  if (!herdrEnabled() || !ref.tabId || !ref.workspaceId) return false
  try {
    raw(['workspace', 'focus', ref.workspaceId])
    raw(['tab', 'focus', ref.tabId])
    return true
  } catch {
    return false
  }
}

export function requireRunner(): void {
  if (herdrEnabled()) {
    try {
      execFileSync('herdr', ['--help'], { stdio: 'ignore', timeout: 5_000 })
    } catch {
      throw new Error('herdr not found - install it or set herdr.enabled=false in devctl.config.json')
    }
  }
}

export function findRefByLabel(workspaceId: string | undefined, label: string, port?: number, cwd?: string): TProcRef | null {
  if (!herdrEnabled() || !workspaceId) return null
  const tabs = listTabs(workspaceId).filter((t) => t.label === label)
  if (tabs.length === 0) return null
  const tabId = tabs[0].tab_id
  for (const extra of tabs.slice(1)) {
    try {
      raw(['tab', 'close', extra.tab_id])
    } catch {}
  }
  let pid: number | undefined
  let startToken: string | undefined
  if (port) {
    const listeners = pidsListeningOnPort(port)
    const owner = cwd ? listeners.find((candidate) => pidCwd(candidate) === cwd) : listeners[0]
    if (owner) {
      pid = owner
      startToken = processStartToken(owner) ?? undefined
    }
  }
  return { workspaceId, tabId, paneId: paneIdForTab(tabId) ?? undefined, pid, startToken, port: port ?? 0 }
}
