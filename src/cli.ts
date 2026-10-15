const PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean)
process.env.PATH = [...PATH_DIRS, ...pathEntries.filter((d) => !PATH_DIRS.includes(d))].join(':')

import { closeWorkspaceByLabel, findRefByLabel, focusTab, focusWorkspace, refAlive, refExited, refOutput, requireRunner, rerunIn, start, stopRef, sweepDevctlTabs } from './session'
import { commandEnv, killTree, pidCwd, pidsListeningOnPort, processStartToken, shQuote, tcpAlive } from './process'
import { loadConfig, repoDir, resolveConfigPath } from './config'
import { validateConfig } from './validate'
import { createWorktree, isShared, removeWorktree, repoKeys as repoKeysFromRegistry, entryKey, findWorktree, listAllWorktrees, listWorktrees, parseTarget, resolveCwdTarget, type TRepoKey } from './registry'
import { seedEnvFiles } from './envfile'
import { loadState, saveState, STATE_FILE, type TStackState, type TDevctlState } from './state'
import { depsOf, dependentsOf, hasWiring, planStack, providersOf, resolveEnv, type TStackPlan } from './stacks'
import { overrideFile, setOverride, unsetOverride } from './envOverrides'
import { discoverStacks, resolveStack } from './stackRegistry'
import { activeRoutes, alias as portlessAlias, dnsName as portlessDnsName, hasRoute, namedUrlsEnabled, portlessAvailable, portlessBin, portlessProxyUp, portlessUrl, proxyPort, removeAlias as portlessRemoveAlias, startProxy, stopProxy } from './portless'
import { sleep, colors, setQuiet, out, quiet, setColorEnabled } from './util'
import { parseArgs, flag, opt, positional, type TArgs, UsageError } from './args'
import { tailFile } from './logtail'
import { execFile } from 'child_process'
import { debugFailure, runDiagnosis } from './debugAgent'
import fs from 'fs'
import path from 'path'
import readline from 'node:readline/promises'
import { execFileSync } from 'child_process'

function systemNotify(message: string): void {
  try {
    const safe = message.replaceAll('\\', '').replaceAll('"', "'")
    execFileSync('osascript', ['-e', `display notification "${safe}" with title "devctl"`], { timeout: 5000, stdio: 'ignore' })
  } catch {}
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function targetArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'))
}

const REPOS_SET = new Set(repoKeysFromRegistry())

function isRepoName(arg: string): boolean {
  return REPOS_SET.has(arg.split('/')[0])
}

async function tabAlive(stack: TStackState): Promise<boolean> {
  return refAlive({ ...stack.ref, port: stack.port })
}

async function stackStatus(stack: TStackState, named: boolean): Promise<{ alive: boolean; listening: boolean; portlessUrl: string | null }> {
  const listening = await tcpAlive(stack.port)
  const alive = isShared(stack.repo) ? listening : await tabAlive(stack)
  const portlessLink = named && stack.portlessName && !isShared(stack.repo) ? await portlessUrl(stack.portlessName) : null
  return { alive, listening, portlessUrl: portlessLink }
}

interface TStartSummary {
  started: string[]
  reused: string[]
  restarted: string[]
  failed: string[]
  shared: string[]
}

function detectInstall(cwd: string): string | null {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install'
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn install'
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm install'
  return null
}

function ensureDeps(key: string, repo: TRepoKey, wt: { path: string }): void {
  if (isShared(repo)) return
  seedEnvFiles(wt.path, repoDir(repo))
  const nm = path.join(wt.path, 'node_modules')
  if (fs.existsSync(path.join(nm, '.bin'))) return
  try {
    if (fs.lstatSync(nm).isSymbolicLink()) {
      const target = path.resolve(path.dirname(nm), fs.readlinkSync(nm))
      if (!fs.existsSync(target)) {
        fs.rmSync(nm)
        out(colors.yellow(`~ ${key}: removed dangling node_modules symlink`))
      }
    }
  } catch {}
  const cmd = loadConfig().services[repo]?.install ?? detectInstall(wt.path)
  if (!cmd) return
  out(colors.yellow(`~ ${key}: node_modules missing - running ${cmd}`))
  execFileSync('bash', ['-c', cmd], { cwd: wt.path, env: commandEnv(), stdio: 'inherit', timeout: 10 * 60_000 })
}

async function ensureStack(
  repo: TRepoKey,
  branchOrName: string,
  state: TDevctlState,
  stackDef: { name: string; services: Partial<Record<string, string>> } | undefined,
  attempted: Set<string>,
  force: boolean,
  summary: TStartSummary,
): Promise<void> {
  const wt0 = findWorktree(repo, branchOrName)
  const key0 = entryKey(wt0)
  if (attempted.has(key0)) return
  attempted.add(key0)

  for (const dep of depsOf(state, repo, stackDef)) {
    await ensureStack(dep.repo, dep.worktree ?? 'head', state, stackDef, attempted, force, summary)
  }

  const wt = findWorktree(repo, branchOrName)
  const key = entryKey(wt)
  const portlessName = portlessDnsName(repo, wt)
  const plan = planStack(repo, wt, state, stackDef)
  const wiringFingerprint = hasWiring(repo) ? JSON.stringify({ port: plan.port, env: plan.env }) : undefined

  const existingRef = findRefByLabel(trackedTabWorkspace(state, key), key)
  const tracked = state.stacks[key]

  const recordStack = (ref: TStackState['ref'], startedAt?: string) => {
    const entry: TStackState = {
      key,
      repo,
      worktree: wt.name,
      branch: wt.branch,
      ref,
      port: wt.port,
      url: `http://localhost:${wt.port}`,
      portlessName,
      stack: stackDef?.name,
      wiring: wiringFingerprint,
      startedAt: startedAt ?? new Date().toISOString(),
    }
    state.stacks[entry.key] = entry
    saveState(state)
    if (!isShared(repo) && namedUrlsEnabled(state)) {
      portlessAlias(portlessName, wt.port)
    }
  }

  const existingTrackedRef = tracked?.ref ? { ...tracked.ref, port: wt.port } : null
  const refFromTab = existingRef ?? (existingTrackedRef && (await refAlive(existingTrackedRef)) ? existingTrackedRef : null)

  if (refFromTab) {
    if (await tcpAlive(wt.port)) {
      const claim = tracked?.stack
      const needsRewire = hasWiring(repo) && (claim !== stackDef?.name || tracked?.wiring !== wiringFingerprint)
      if (needsRewire) {
        out(colors.yellow(`~ ${key}: rewiring for stack ${stackDef?.name ?? '(global)'} - restarting`))
        stopRef(refFromTab, key, { force })
        for (let i = 0; i < 20 && (await tcpAlive(wt.port)); i++) await sleep(500)
        if (await tcpAlive(wt.port)) throw new Error(`port ${wt.port} still occupied after stopping ${key} - re-run with --force`)
        ensureDeps(key, repo, wt)
        const ref = start(key, plan.path, plan.env, plan.cmd, plan.port)
        recordStack(ref)
        if (await waitFor(key, plan, ref, false)) {
          if (isShared(repo)) summary.shared.push(key)
          else summary.restarted.push(key)
        }
        else {
          summary.failed.push(key)
          cleanupFailedEntry(state, key, ref)
        }
        return
      }
      recordStack(refFromTab, tracked?.startedAt)
      if (isShared(repo)) summary.shared.push(key)
      else summary.reused.push(key)
      out(colors.green(`● ${key} already running http://localhost:${wt.port}`))
      return
    }
    out(colors.yellow(`~ ${key}: tab exists but port ${wt.port} is down - restarting`))
    if (refFromTab.paneId) {
      rerunIn(refFromTab, plan.env, plan.cmd)
      recordStack(refFromTab)
      if (await waitFor(key, plan, refFromTab, false)) {
        if (isShared(repo)) summary.shared.push(key)
        else summary.restarted.push(key)
      }
      else {
        summary.failed.push(key)
        cleanupFailedEntry(state, key, refFromTab)
      }
    } else {
      stopRef(refFromTab, key, { force })
      ensureDeps(key, repo, wt)
      const ref = start(key, plan.path, plan.env, plan.cmd, plan.port)
      recordStack(ref)
      if (await waitFor(key, plan, ref, false)) {
        if (isShared(repo)) summary.shared.push(key)
        else summary.restarted.push(key)
      }
      else {
        summary.failed.push(key)
        cleanupFailedEntry(state, key, ref)
      }
    }
    return
  }

  if (tracked) delete state.stacks[key]

  ensureDeps(key, repo, wt)
  const shared = isShared(repo)

  if (!shared) {
    const occupants = pidsListeningOnPort(plan.port)
    const adoptable = occupants.filter((pid) => pidCwd(pid) === plan.path)
    if (occupants.length > 0 && adoptable.length === occupants.length) {
      const pid = adoptable[0]
      out(colors.yellow(`~ ${key}: adopting process ${pid} on port ${plan.port} (left running by an earlier devctl run)`))
      const ref: TStackState['ref'] = {
        pid,
        startToken: processStartToken(pid) ?? undefined,
        logFile: `${process.env.HOME ?? ''}/.devctl/logs/${key.replace(/\//g, '__')}.log`,
        port: plan.port,
      }
      recordStack(ref)
      if (await waitFor(key, plan, ref, false)) {
        summary.reused.push(key)
        return
      }
      out(colors.yellow(`~ ${key}: adopted process is not healthy - restarting`))
      killTree(pid)
      delete state.stacks[key]
      saveState(state)
    }
    if (occupants.length > 0 && !force) {
      throw new Error(`port ${plan.port} is occupied by pid ${occupants.join(', ')}; stop it or re-run with --force`)
    }
    for (const pid of occupants) {
      out(colors.yellow(`~ --force: killing pid ${pid} on port ${plan.port}`))
      killTree(pid)
    }
  }

  const ref = start(key, plan.path, plan.env, plan.cmd, plan.port, undefined, { detached: shared })
  recordStack(ref)
  const ok = await waitFor(key, plan, ref, shared)
  if (ok && !ref.pid) {
    const pid = pidsListeningOnPort(plan.port)[0]
    if (pid) {
      ref.pid = pid
      ref.startToken = processStartToken(pid) ?? undefined
      saveState(state)
    }
  }
  if (!ok) {
    summary.failed.push(key)
    cleanupFailedEntry(state, key, ref)
  } else if (shared) {
    summary.shared.push(key)
  } else {
    summary.started.push(key)
  }
}

function trackedTabWorkspace(state: TDevctlState, key: string): string | undefined {
  return state.stacks[key]?.ref.workspaceId
}

function runHealthCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: 15_000, env: commandEnv() }, (error) => resolve(!error))
  })
}

function healthy(plan: TStackPlan): Promise<boolean> {
  return plan.healthCommand ? runHealthCommand(plan.healthCommand) : tcpAlive(plan.port)
}

async function waitFor(key: string, plan: TStackPlan, ref: TStackState['ref'], launcherExits: boolean): Promise<boolean> {
  if (!quiet()) process.stdout.write(`… ${key} starting on ${plan.port} `)
  const deadline = Date.now() + plan.healthTimeoutMs
  while (Date.now() < deadline) {
    if (await healthy(plan)) {
      out(colors.green(`ready http://localhost:${plan.port}`))
      return true
    }
    if (!launcherExits && refExited(ref)) {
      console.log(colors.red(`FAILED - process exited before passing health check on ${plan.port}`))
      console.log(colors.dim(`--- output (${key}) ---`))
      console.log(refOutput(ref))
      process.exitCode = 1
      await debugFailure({ key, cmd: plan.cmd, port: plan.port, cwd: plan.path, output: refOutput(ref, 120) })
      return false
    }
    const recent = refOutput(ref, 15)
    if (recent.includes('app crashed') || recent.includes('EADDRINUSE')) {
      console.log(colors.red(`FAILED - process crashed before listening on ${plan.port}`))
      console.log(colors.dim(`--- output (${key}) ---`))
      console.log(refOutput(ref))
      process.exitCode = 1
      await debugFailure({ key, cmd: plan.cmd, port: plan.port, cwd: plan.path, output: refOutput(ref, 120) })
      return false
    }
    await sleep(1000)
  }
  console.log(colors.red(`FAILED to listen on ${plan.port}`))
  console.log(colors.dim(`--- output (${key}) ---`))
  console.log(refOutput(ref))
  process.exitCode = 1
  await debugFailure({ key, cmd: plan.cmd, port: plan.port, cwd: plan.path, output: refOutput(ref, 120) })
  return false
}

function cleanupFailedEntry(state: TDevctlState, key: string, ref: TStackState['ref']): void {
  try {
    stopRef({ ...ref, port: ref.port }, key)
  } catch {}
  const entry = state.stacks[key]
  if (!entry) return
  if (entry.portlessName) {
    try {
      portlessRemoveAlias(entry.portlessName)
    } catch {}
  }
  delete state.stacks[key]
  saveState(state)
}

function planTargets(
  state: TDevctlState,
  targets: Array<{ repo: TRepoKey; branchOrName: string }>,
  stackDef: { name: string; services: Partial<Record<string, string>> } | undefined,
): Array<{ key: string; repo: TRepoKey; target: string; port: number; shared: boolean; cmd: string }> {
  const seen = new Set<string>()
  const plan: Array<{ key: string; repo: TRepoKey; target: string; port: number; shared: boolean; cmd: string }> = []
  const visit = (repo: TRepoKey, branchOrName: string): void => {
    const wt = findWorktree(repo, branchOrName)
    const key = entryKey(wt)
    if (seen.has(key)) return
    seen.add(key)
    for (const dep of depsOf(state, repo, stackDef)) visit(dep.repo, dep.worktree ?? 'head')
    const svc = loadConfig().services[repo]
    plan.push({ key, repo, target: wt.name, port: wt.port, shared: Boolean(svc?.shared), cmd: svc?.command ?? '' })
  }
  for (const t of targets) visit(t.repo, t.branchOrName)
  return plan
}

async function cmdUp(a: TArgs): Promise<void> {
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  requireRunner()
  const state = loadState()
  if (namedUrlsEnabled(state) && !(await portlessProxyUp())) {
    out(colors.yellow('~ portless proxy is down - named URLs will not resolve until `devctl portless on`'))
  }
  const target = a.positionals[0]
  const force = flag(a, 'force')
  let targets: Array<{ repo: TRepoKey; branchOrName: string }>
  let stackDef: { name: string; services: Partial<Record<string, string>> } | undefined
  if (target && !isRepoName(target)) {
    stackDef = resolveStack(target, state.stackDefs)
    assertStackDeps(stackDef.services)
    state.stackDefs[target] = stackDef
    saveState(state)
    targets = servicesToTargets(stackDef)
    out(`stack ${target}: ${stackSummary(stackDef)}`)
  } else if (target) {
    const t = parseTarget(target)
    targets = [{ repo: t.repo, branchOrName: t.worktree.name }]
  } else {
    const cwdTarget = resolveCwdTarget()
    if (cwdTarget) {
      targets = [{ repo: cwdTarget.repo, branchOrName: cwdTarget.worktree.name }]
      out(`detected ${entryKey(cwdTarget.worktree)} from cwd`)
    } else if (flag(a, 'all')) {
      targets = repoKeysFromRegistry().filter((repo) => !isShared(repo)).map((repo) => ({ repo, branchOrName: 'head' }))
      out('daily stack: all current HEADs')
    } else {
      throw new UsageError('no repo detected from cwd; pass a stack or service target, or use `devctl up --all`')
    }
  }

  if (flag(a, 'dry-run')) {
    const plan = planTargets(state, targets, stackDef)
    if (plan.length === 0) out('dry-run: nothing to start')
    for (const p of plan) {
      out(`${p.shared ? '(shared) ' : ''}${p.key} :${p.port}  ${p.cmd}`)
    }
    return
  }

  const attempted = new Set<string>()
  const summary: TStartSummary = { started: [], reused: [], restarted: [], failed: [], shared: [] }

  const results = await Promise.allSettled(
    targets.map((t) => ensureStack(t.repo, t.branchOrName, state, stackDef, attempted, force, summary)),
  )
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error(colors.red(`devctl: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`))
      process.exitCode = 1
    }
  }

  if (stackDef) {
    const members = new Set(Object.entries(stackDef.services).map(([repo, wt]) => `${repo}/${wt}`))
    for (const [key, entry] of Object.entries(state.stacks)) {
      if (entry.stack !== stackDef.name || members.has(key) || isShared(entry.repo)) continue
      out(colors.yellow(`~ ${key}: dropped from stack ${stackDef.name} - stopping`))
      stopRunningEntry(state, key, force)
    }
    saveState(state)
  }

  if (json) {
    console.log(
      JSON.stringify(
        { ok: summary.failed.length === 0 && results.every((r) => r.status === 'fulfilled'), ...summary },
        null,
        2,
      ),
    )
    if (summary.failed.length > 0 || results.some((r) => r.status === 'rejected')) process.exitCode = 1
    return
  }

  const parts: string[] = []
  if (summary.started.length) parts.push(colors.green(`${summary.started.length} started`))
  if (summary.reused.length) parts.push(colors.green(`${summary.reused.length} reused`))
  if (summary.restarted.length) parts.push(colors.yellow(`${summary.restarted.length} restarted`))
  if (summary.failed.length) parts.push(colors.red(`${summary.failed.length} failed: ${summary.failed.join(', ')}`))
  if (summary.shared.length) parts.push(colors.dim(`+ ${summary.shared.join(', ')} (shared)`))
  if (parts.length) console.log(colors.dim(`summary: ${parts.join(', ')}`))
}

function servicesToTargets(stackDef: { services: Partial<Record<string, string>> }): Array<{ repo: TRepoKey; branchOrName: string }> {
  return repoKeysFromRegistry()
    .filter((r) => stackDef.services[r] && stackDef.services[r] !== 'test' && stackDef.services[r] !== 'prod' && !isShared(r))
    .map((r) => ({ repo: r, branchOrName: stackDef.services[r]! }))
}

function stackSummary(stackDef: { services: Partial<Record<string, string>> }): string {
  return (
    repoKeysFromRegistry()
      .filter((r) => stackDef.services[r])
      .map((r) => `${r}/${stackDef.services[r]}`)
      .join(', ') || '(no services)'
  )
}

async function cmdDown(a: TArgs): Promise<void> {
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  requireRunner()
  const state = loadState()
  const wantsAll = flag(a, 'all')
  const force = flag(a, 'force')
  const target = a.positionals[0]
  const stopped: string[] = []

  const stopOne = (key: string): void => {
    try {
      stopRunningEntry(state, key, force)
      stopped.push(key)
    } catch (err) {
      console.error(colors.red(`devctl: ${err instanceof Error ? err.message : String(err)}`))
      process.exitCode = 1
    }
  }

  if (target && !isRepoName(target) && !wantsAll) {
    const stackDef = resolveStack(target, state.stackDefs)
    out(`stack ${target}: down`)
    let left = 0
    for (const repo of repoKeysFromRegistry()) {
      const service = stackDef.services[repo]
      if (service && service !== 'test' && service !== 'prod') {
        const wt = findWorktree(repo, service)
        const key = entryKey(wt)
        const claim = state.stacks[key]?.stack
        if (claim && claim !== stackDef.name && state.stackDefs[claim]?.services?.[repo] === service) {
          left++
          out(colors.dim(`~ ${key} still claimed by stack ${claim} - leaving it running`))
          continue
        }
        if (claim && claim !== stackDef.name) {
          out(colors.dim(`~ ${key}: stale claim from stack ${claim} - taking it over`))
        }
        if (!state.stacks[key]) {
          left++
          continue
        }
        stopOne(key)
      }
    }
    closeWorkspaceByLabel(target)
    saveState(state)
    out(colors.green(`stack ${target}: stopped ${stopped.length}, untouched ${left}`))
    emitMutationResult(json, { ok: process.exitCode !== 1, stopped })
    return
  }

  if (wantsAll) {
    const keys = Object.keys(state.stacks)
    const stoppedRepos = new Set(keys.map((k) => k.split('/')[0]))
    const sharedRunning: string[] = []
    for (const [name, svc] of Object.entries(loadConfig().services)) {
      if (svc.shared && !stoppedRepos.has(name) && (await tcpAlive(svc.basePort))) sharedRunning.push(name)
    }
    if (keys.length === 0 && sharedRunning.length === 0) {
      out('nothing running')
      emitMutationResult(json, { ok: true, stopped: [] })
      return
    }
    const detail = [...keys, ...sharedRunning.map((s) => `${s} (shared)`)].join(', ')
    if (!flag(a, 'yes')) {
      if (!process.stdin.isTTY) throw new Error('non-interactive - re-run with --yes to skip confirmation')
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(`stop ${keys.length + sharedRunning.length} service(s): ${detail}? [y/N] `)
      rl.close()
      if (!/^(y|yes)$/i.test(answer.trim())) {
        out('aborted')
        return
      }
    }
    for (const key of keys) stopOne(key)
    for (const name of sharedRunning) {
      runStopCommand(name)
      stopped.push(`${name}/head`)
      out(`■ ${name}/head stopped`)
    }
    const swept = sweepDevctlTabs()
    if (swept > 0) out(`swept ${swept} leftover herdr tab(s)`)
    for (const name of Object.keys(state.stackDefs)) closeWorkspaceByLabel(name)
    saveState(state)
    emitMutationResult(json, { ok: process.exitCode !== 1, stopped })
    return
  }

  const key = target
    ? entryKey(parseTarget(target).worktree)
    : (() => {
        const cwd = resolveCwdTarget()
        if (!cwd) throw new UsageError('Not inside a repo - pass a target, a stack name, or --all')
        return entryKey(cwd.worktree)
      })()

  stopOne(key)
  saveState(state)
  emitMutationResult(json, { ok: process.exitCode !== 1, stopped })
}

function emitMutationResult(json: boolean, result: Record<string, unknown>): void {
  if (json) console.log(JSON.stringify(result, null, 2))
}

function runStopCommand(repo: TRepoKey): void {
  const svc = loadConfig().services[repo]
  if (!svc?.shared || !svc.stopCommand) return
  execFileSync('bash', ['-c', svc.stopCommand], { cwd: repoDir(repo), env: commandEnv(), stdio: 'ignore' })
}

function stopRunningEntry(state: TDevctlState, key: string, force: boolean): void {
  const stack = state.stacks[key]
  if (!stack) {
    runStopCommand(key.split('/')[0])
    out(colors.dim(`${key} not tracked by devctl`))
    return
  }
  const shared = isShared(stack.repo)
  try {
    stopRef({ ...stack.ref, port: stack.port }, stack.key, { keepPort: shared, force })
  } finally {
    if (shared) runStopCommand(stack.repo)
    portlessRemoveAlias(stack.portlessName ?? `${stack.repo}-${stack.worktree}`)
    delete state.stacks[key]
    saveState(state)
  }
  out(colors.green(`■ ${key} stopped`))
}

async function restartStack(key: string, state: TDevctlState, force: boolean): Promise<void> {
  const stack = state.stacks[key]
  if (!stack || !(await tabAlive(stack))) return
  const def = stack.stack ? state.stackDefs[stack.stack] : undefined
  out(colors.yellow(`~ restarting ${key} for new env`))
  const ref: TStackState['ref'] = { ...stack.ref, port: stack.port }
  stopRef(ref, key, { force })
  for (let i = 0; i < 20 && (await tcpAlive(stack.port)); i++) await sleep(500)
  if (await tcpAlive(stack.port)) throw new Error(`port ${stack.port} still occupied after stopping ${key} - re-run with --force`)
  const wt = findWorktree(stack.repo, stack.worktree)
  const plan = planStack(stack.repo as TRepoKey, wt, state, def)
  const newRef = start(key, plan.path, plan.env, plan.cmd, plan.port, undefined, { detached: isShared(stack.repo) })
  recordOnly(state, key, stack, newRef)
  if (await waitFor(key, plan, newRef, isShared(stack.repo))) return
  cleanupFailedEntry(state, key, newRef)
}

function recordOnly(state: TDevctlState, key: string, old: TStackState, ref: TStackState['ref']): void {
  const entry: TStackState = { ...old, ref, startedAt: new Date().toISOString() }
  state.stacks[entry.key] = entry
  saveState(state)
}

function stackForService(a: TArgs, state: TDevctlState, service: string): string {
  const explicit = opt(a, 'stack')
  if (explicit) {
    try {
      resolveStack(explicit, state.stackDefs)
    } catch {
      throw new UsageError(`unknown stack "${explicit}" - see devctl stack ls`)
    }
    return explicit
  }
  const running = Object.values(state.stacks).find((entry) => entry.repo === service && entry.stack)
  if (running?.stack) return running.stack
  const owners = [
    ...Object.entries(state.stackDefs).filter(([, def]) => def.services[service]).map(([name]) => name),
    ...discoverStacks().filter((def) => def.services[service]).map((def) => def.name),
  ]
  if (owners.length === 1) return owners[0]
  if (owners.length === 0) throw new UsageError(`no stack defines "${service}" - pass --stack <name>`)
  throw new UsageError(`"${service}" is in ${owners.join(', ')} - pass --stack <name>`)
}

function maskEnv(value: string, key: string): string {
  return SECRET_KEY.test(key) ? '[redacted]' : value
}

function cmdEnvShow(a: TArgs): void {
  const target = a.positionals[1]
  if (!target) throw new UsageError('usage: devctl env show <service>[/<worktree>] [--stack <name>] [--json]')
  const state = loadState()
  const t = parseTarget(target)
  const stack = stackForService(a, state, t.repo)
  const stackDef = resolveStack(stack, state.stackDefs)
  const wtName = t.worktree.name === 'head' ? stackDef?.services[t.repo] ?? 'head' : t.worktree.name
  const wt = findWorktree(t.repo, wtName)
  const { env, display } = resolveEnv(t.repo, wt, state, stackDef)
  const file = overrideFile(stack, t.repo)
  const reveal = flag(a, 'reveal')
  if (flag(a, 'json')) {
    const masked = Object.fromEntries(
      Object.entries(display).map(([key, entry]) => [
        key,
        { value: reveal ? entry.value : maskEnv(entry.value, key), source: entry.source },
      ]),
    )
    console.log(JSON.stringify({ service: t.repo, worktree: wt.name, stack, mode: state.env, overrides: file, env: masked }, null, 2))
    return
  }
  out(`${t.repo}/${wt.name}  stack ${stack}  mode ${state.env}`)
  for (const [key, entry] of Object.entries(display).sort(([a2], [b2]) => a2.localeCompare(b2))) {
    out(`  ${key}=${reveal ? entry.value : maskEnv(entry.value, key)}  ${colors.dim(`← ${entry.source}`)}`)
  }
  out(colors.dim(`  overrides: ${file}${fs.existsSync(file) ? '' : ' (none yet)'}`))
  out(colors.dim(`  exported into the pane as process env: ${Object.keys(env).length} keys`))
}

async function cmdEnvOverride(a: TArgs, mode: 'set' | 'unset' | 'edit'): Promise<void> {
  const service = a.positionals[1]
  if (!service) throw new UsageError(`usage: devctl env ${mode} <service> ${mode === 'edit' ? '' : mode === 'set' ? 'KEY=VALUE ' : 'KEY '}[--stack <name>]`)
  const state = loadState()
  const stack = stackForService(a, state, service)

  if (mode === 'edit') {
    const file = overrideFile(stack, service)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (!fs.existsSync(file)) fs.writeFileSync(file, '')
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'open'
    execFileSync('bash', ['-c', `${editor} ${shQuote(file)}`], { stdio: 'inherit' })
    out(`edited ${file}`)
    return
  }

  const arg = a.positionals[2]
  if (!arg) throw new UsageError(`usage: devctl env ${mode} <service> ${mode === 'set' ? 'KEY=VALUE' : 'KEY'} [--stack <name>]`)

  if (mode === 'set') {
    const eq = arg.indexOf('=')
    if (eq < 1) throw new UsageError('expected KEY=VALUE')
    const key = arg.slice(0, eq).trim()
    const value = arg.slice(eq + 1)
    const file = setOverride(stack, service, key, value)
    out(`set ${key} for ${stack}/${service} → ${file}`)
  } else {
    const removed = unsetOverride(stack, service, arg.trim())
    out(removed ? `unset ${arg} for ${stack}/${service}` : `${arg} was not set for ${stack}/${service}`)
  }

  const affected = Object.entries(state.stacks)
    .filter(([, entry]) => entry.repo === service && entry.stack === stack)
    .map(([key]) => key)
  for (const key of affected) {
    await restartStack(key, state, flag(a, 'force'))
  }
  if (affected.length > 0) out(colors.dim(`restarted ${affected.join(', ')}`))
}

async function cmdEnv(a: TArgs): Promise<void> {
  const sub = a.positionals[0]
  if (sub === 'show') return cmdEnvShow(a)
  if (sub === 'set' || sub === 'unset' || sub === 'edit') return cmdEnvOverride(a, sub)
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  if (sub !== 'test' && sub !== 'prod') {
    throw new UsageError('usage: devctl env test|prod | env show <service>[/<worktree>] | env set|unset|edit <service> [--stack <name>]')
  }
  requireRunner()
  const force = flag(a, 'force')
  const state = loadState()
  state.env = sub
  saveState(state)
  out(`env → ${sub}`)
  const restarted: string[] = []

  for (const key of Object.keys(state.stacks)) {
    const repo = state.stacks[key].repo
    const svc = loadConfig().services[repo]
    if (svc && (svc.wiring || svc.envExternals)) {
      await restartStack(key, state, force)
      restarted.push(key)
    }
  }
  emitMutationResult(json, { ok: process.exitCode !== 1, env: sub, restarted })
}

async function cmdUse(a: TArgs): Promise<void> {
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  const service = a.positionals[0]
  const arg = a.positionals[1]
  if (!service || !arg) throw new UsageError('usage: devctl use <service> <branch|test|prod> [--force] [--json]')
  if (!loadConfig().services[service]) throw new UsageError(`unknown service "${service}" - configured: ${Object.keys(loadConfig().services).join(', ')}`)
  if (isShared(service)) throw new UsageError(`"${service}" is a shared service - it has no worktree targets`)
  const dependents = dependentsOf(service)
  if (dependents.length === 0) throw new UsageError(`nothing depends on "${service}" - wire it up via services.<svc>.wiring or .dependsOn`)
  requireRunner()
  const force = flag(a, 'force')
  const state = loadState()
  let target: string
  if (arg === 'test' || arg === 'prod') {
    target = arg
  } else {
    const name = arg.startsWith(`${service}/`) ? arg.slice(service.length + 1) : arg
    findWorktree(service as TRepoKey, name)
    target = `${service}/${name}`
  }
  for (const dep of dependents) state.targets[dep] = target
  saveState(state)
  out(`${service} target → ${target} (for ${dependents.join(', ')}; stacks with a ${service} service override this)`)
  const restarted: string[] = []

  for (const key of Object.keys(state.stacks)) {
    if (dependents.includes(state.stacks[key].repo)) {
      await restartStack(key, state, force)
      restarted.push(key)
    }
  }
  emitMutationResult(json, { ok: process.exitCode !== 1, service, target, dependents, restarted })
}

async function cmdStatus(a: TArgs): Promise<void> {
  const json = flag(a, 'json')
  const check = flag(a, 'check')
  const state = loadState()
  const named = namedUrlsEnabled(state)
  const rows = await Promise.all(
    Object.values(state.stacks).map(async (s) => ({
      ...s,
      stackLabel: s.stack ? state.stackDefs[s.stack]?.label : undefined,
      ...(await stackStatus(s, named)),
    })),
  )

  if (json) {
    console.log(
      JSON.stringify(
        { env: state.env, targets: state.targets, stacks: rows },
        null,
        2,
      ),
    )
    if (check && rows.some((row) => !row.alive || !row.listening)) process.exitCode = 1
    return
  }

  if (rows.length === 0) {
    console.log(colors.dim('nothing running - try `devctl up`'))
    return
  }
  for (const r of rows) {
    const status = r.alive && r.listening ? colors.green('● ready') : r.alive ? colors.yellow('● starting') : colors.red('○ dead')
    console.log(`${status} ${r.key.padEnd(50)} ${r.stackLabel ?? r.stack ?? ''} ${r.portlessUrl ?? r.url}`)
  }
  if (check && rows.some((row) => !row.alive || !row.listening)) process.exitCode = 1
}

function cmdWhich(a: TArgs): void {
  const all = listAllWorktrees()
  if (flag(a, 'json')) {
    console.log(JSON.stringify(all, null, 2))
    return
  }
  for (const wt of all) {
    const branch = wt.branch ? colors.dim(` [${wt.branch}]`) : colors.red(' [detached]')
    console.log(`${wt.repo.padEnd(8)} ${wt.name.padEnd(40)} :${wt.port}${branch}`)
  }
}

function cmdLogs(a: TArgs): void {
  const state = loadState()
  const target = a.positionals[0]
  if (!target) throw new UsageError('usage: devctl logs <repo/branch> [--lines N] [--follow]')
  const linesRaw = opt(a, 'lines')
  const lines = linesRaw === undefined ? 50 : Number(linesRaw)
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) throw new UsageError('--lines must be an integer between 1 and 10000')
  const t = parseTarget(target)
  const key = entryKey(t.worktree)
  const stack = state.stacks[key]
  const file = stack?.ref?.logFile ?? `${process.env.HOME}/.devctl/logs/${key.replace(/\//g, '__')}.log`
  console.log(colors.dim(`--- ${file} (last ${lines} lines) ---`))
  console.log(tailFile(file, lines))
  if (!flag(a, 'follow')) return
  if (!fs.existsSync(file)) throw new Error(`log file does not exist yet: ${file}`)
  let offset = fs.statSync(file).size
  fs.watchFile(file, { interval: 500 }, (current) => {
    if (current.size < offset) offset = 0
    if (current.size === offset) return
    const stream = fs.createReadStream(file, { start: offset, end: current.size - 1 })
    stream.pipe(process.stdout, { end: false })
    offset = current.size
  })
}

async function cmdDiagnose(a: TArgs): Promise<void> {
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  const target = a.positionals[0]
  if (!target) throw new UsageError('usage: devctl diagnose <service>/<worktree> [--json]')
  const state = loadState()
  const t = parseTarget(target)
  const wt = t.worktree
  const key = entryKey(wt)
  const tracked = state.stacks[key]
  const plan = planStack(t.repo, wt, state, undefined)
  const file = tracked?.ref?.logFile ?? `${process.env.HOME}/.devctl/logs/${key.replace(/\//g, '__')}.log`
  const output = fs.existsSync(file) ? tailFile(file, 120) : ''
  out(colors.dim(`--- diagnosing ${key} (port ${plan.port}) ---`))
  const diagnosis = await runDiagnosis({ key, cmd: plan.cmd, port: plan.port, cwd: plan.path, output })
  if (!diagnosis.trim()) throw new Error('no diagnosis produced (is the debug agent configured?)')
  if (json) {
    console.log(JSON.stringify({ ok: true, key, diagnosis }, null, 2))
    return
  }
  console.log(diagnosis)
}

async function cmdDoctor(a: TArgs): Promise<void> {
  const cfg = loadConfig()
  const state = loadState()
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string }> = []
  const add = (name: string, status: 'ok' | 'warn' | 'error', detail: string) => checks.push({ name, status, detail })
  const binary = (name: string): boolean => {
    try {
      execFileSync('which', [name], { stdio: 'ignore', timeout: 2_000 })
      return true
    } catch {
      return false
    }
  }

  add('config', 'ok', resolveConfigPath())
  add('state', fs.existsSync(STATE_FILE) ? 'ok' : 'warn', fs.existsSync(STATE_FILE) ? STATE_FILE : `${STATE_FILE} has not been created yet`)
  add('git', binary('git') ? 'ok' : 'error', binary('git') ? 'available' : 'not found in PATH')
  add('runner', !cfg.herdr.enabled || binary('herdr') ? 'ok' : 'error', cfg.herdr.enabled ? (binary('herdr') ? 'herdr available' : 'herdr enabled but not found') : 'plain detached process mode')
  const portlessCli = portlessAvailable()
  const portlessProxy = portlessCli ? await portlessProxyUp() : false
  const portlessOn = portlessCli && state.portless !== false
  add(
    'portless',
    portlessCli && portlessProxy && portlessOn ? 'ok' : 'warn',
    !portlessCli
      ? 'not installed; using http://localhost:<port>'
      : !portlessOn
        ? 'disabled; run `devctl portless on` for named URLs'
        : portlessProxy
          ? `proxy up on ${proxyPort()}`
          : 'proxy down; run `devctl portless on` for named URLs',
  )
  if (portlessCli && portlessProxy && portlessOn) {
    const missing = Object.values(state.stacks).filter(
      (entry) => !isShared(entry.repo) && entry.portlessName && !hasRoute(`${entry.portlessName}.localhost`),
    )
    if (missing.length > 0) {
      add('portless:routes', 'warn', `${missing.length} running service(s) without a route - re-run \`devctl up <stack>\` to re-register`)
    }
  }

  for (const [service, serviceConfig] of Object.entries(cfg.services)) {
    const dir = repoDir(service)
    add(`repo:${service}`, fs.existsSync(dir) ? 'ok' : 'error', dir)
    const occupants = pidsListeningOnPort(serviceConfig.basePort)
    const tracked = Object.values(state.stacks).some((entry) => entry.repo === service && entry.port === serviceConfig.basePort)
    if (occupants.length > 0 && !tracked && !serviceConfig.shared) {
      add(`port:${service}`, 'warn', `${serviceConfig.basePort} is used by untracked pid ${occupants.join(', ')}`)
    }
    if (!serviceConfig.shared) {
      for (const [mode, file] of Object.entries(cfg.envBaseFiles)) {
        const envPath = path.join(dir, file)
        if (!fs.existsSync(envPath)) {
          add(`envfile:${service}/${mode}`, 'warn', `${envPath} missing - env seeding and remote wiring for this mode will fail`)
        }
      }
    }
    const byBranch = new Map<string, number>()
    for (const wt of listWorktrees(service)) {
      if (!wt.branch) continue
      byBranch.set(wt.branch, (byBranch.get(wt.branch) ?? 0) + 1)
    }
    for (const [branch, count] of byBranch) {
      if (count > 1) add(`conflict:${service}/${branch}`, 'warn', `${count} worktrees share branch "${branch}" - targets will resolve ambiguously`)
    }
  }

  for (const entry of Object.values(state.stacks)) {
    if (!cfg.services[entry.repo]) {
      add(`state:${entry.key}`, 'error', 'references a service missing from config')
      continue
    }
    if (cfg.services[entry.repo].shared) continue
    const alive = await tabAlive(entry)
    const listening = await tcpAlive(entry.port)
    if (!alive && listening) {
      add(`orphan:${entry.key}`, 'warn', `port ${entry.port} is listening but the tracked runner session is gone - down ${entry.key} or --force`)
    } else if (!alive && !listening) {
      add(`stale:${entry.key}`, 'warn', 'tracked but not running - `devctl down <key>` cleans it up')
    }
  }

  if (flag(a, 'json')) {
    console.log(JSON.stringify({ ok: !checks.some((check) => check.status === 'error'), checks }, null, 2))
  } else {
    for (const check of checks) {
      const marker = check.status === 'ok' ? colors.green('✓') : check.status === 'warn' ? colors.yellow('!') : colors.red('✗')
      console.log(`${marker} ${check.name.padEnd(28)} ${check.detail}`)
    }
  }
  if (checks.some((check) => check.status === 'error')) process.exitCode = 1
}

async function cmdPortless(a: TArgs): Promise<void> {
  const sub = a.positionals[0]
  const json = flag(a, 'json')
  if (json) setQuiet(true)
  const bin = portlessBin()
  const state = loadState()

  if (!sub || sub === 'status') {
    const available = portlessAvailable()
    const proxyUp = available ? await portlessProxyUp() : false
    const routes = available ? [...activeRoutes()] : []
    const enabled = namedUrlsEnabled(state)
    if (json) {
      console.log(JSON.stringify({ installed: Boolean(bin), usable: available, bin, enabled, proxyUp, port: proxyPort(), routes }, null, 2))
      return
    }
    out(`portless: ${available ? 'installed' : bin ? 'installed but not runnable (needs Node 24+)' : 'not installed'}`)
    if (bin) out(colors.dim(`  ${bin}`))
    out(`  named URLs: ${enabled ? 'on' : 'off'}`)
    out(`  proxy: ${proxyUp ? `up on ${proxyPort()}` : 'down'}`)
    out(`  routes: ${routes.length}`)
    for (const route of routes) out(colors.dim(`    https://${route}`))
    return
  }

  if (sub !== 'on' && sub !== 'off') {
    throw new UsageError('usage: devctl portless on [--port N] [--no-restart] [--force] | off [--no-restart] [--force] | status [--json]')
  }
  if (sub === 'on' && !portlessAvailable()) {
    throw new Error('portless is not usable - install it with `pnpm install` in the devctl checkout (needs Node 24+)')
  }

  if (sub === 'on') {
    const portRaw = opt(a, 'port')
    const port = portRaw === undefined ? undefined : Number(portRaw)
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new UsageError('--port must be between 1 and 65535')
    startProxy(port)
  } else {
    stopProxy()
  }
  state.portless = sub === 'on'
  saveState(state)

  const running = Object.values(state.stacks).filter(
    (entry): entry is TStackState & { portlessName: string } => !isShared(entry.repo) && Boolean(entry.portlessName),
  )
  for (const entry of running) {
    if (sub === 'on') portlessAlias(entry.portlessName, entry.port)
    else portlessRemoveAlias(entry.portlessName)
  }

  const restarted: string[] = []
  if (running.length > 0 && !flag(a, 'no-restart')) {
    requireRunner()
    for (const entry of running) {
      await restartStack(entry.key, state, flag(a, 'force'))
      restarted.push(entry.key)
    }
  }

  const detail = restarted.length > 0
    ? `; restarted ${restarted.join(', ')}`
    : running.length > 0
      ? '; re-run `devctl up <stack>` to refresh service env'
      : ''
  out(colors.green(`portless ${sub}${detail}`))
  emitMutationResult(json, { ok: true, portless: sub === 'on', routes: running.length, restarted })
}

function cmdAttach(a: TArgs): void {
  requireRunner()
  const target = a.positionals[0]
  const entry = target ? loadState().stacks[target] : undefined
  if (entry && focusTab({ ...entry.ref, port: entry.port })) {
    out(colors.green(`focused ${target}`))
    return
  }
  const workspace = target ?? loadConfig().herdr.workspace
  focusWorkspace(workspace)
  out(colors.green(`focused workspace ${workspace}`))
}

async function confirmAction(a: TArgs, question: string): Promise<void> {
  if (flag(a, 'yes')) return
  if (!process.stdin.isTTY) throw new Error('non-interactive - re-run with --yes to skip confirmation')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  if (!/^(y|yes)$/i.test(answer.trim())) throw new Error('aborted')
}

async function cmdRestart(a: TArgs): Promise<void> {
  const target = a.positionals[0]
  if (!target) throw new UsageError('usage: devctl restart <stack | repo[/branch]> [--force]')
  requireRunner()
  const force = flag(a, 'force')

  if (!isRepoName(target.split('/')[0])) {
    await cmdDown(parseArgs([target, ...(force ? ['--force'] : [])], { boolean: ['all', 'yes', 'force', 'json'] }, 'restart'))
    await cmdUp(parseArgs([target, ...(force ? ['--force'] : [])], { boolean: ['force', 'all', 'dry-run', 'json'] }, 'restart'))
    return
  }

  const state = loadState()
  const t = parseTarget(target)
  const key = entryKey(t.worktree)
  const tracked = state.stacks[key]
  const stackDef = tracked?.stack ? resolveStack(tracked.stack, state.stackDefs) : undefined

  if (tracked) stopRunningEntry(state, key, force)
  saveState(state)

  const attempted = new Set<string>()
  const summary: TStartSummary = { started: [], reused: [], restarted: [], failed: [], shared: [] }
  await ensureStack(t.repo, t.worktree.name, state, stackDef, attempted, force, summary)
  if (summary.failed.length > 0) process.exitCode = 1
  else out(colors.green(`restarted ${key}${stackDef ? ` (stack ${stackDef.name})` : ''}`))
}

const SECRET_KEY = /(key|token|secret|password|dsn|credential)/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redact(v)]),
    )
  }
  return value
}

function configPathGet(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj
  for (const part of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function configPathSet(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cur: Record<string, unknown> = obj
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cur[part] = {}
    }
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function cmdConfig(a: TArgs): void {
  const sub = a.positionals[0]
  const file = resolveConfigPath()
  if (sub === 'show') {
    const redacted = redact(loadConfig())
    if (flag(a, 'json')) console.log(JSON.stringify(redacted, null, 2))
    else console.log(`# ${file} (secrets redacted)\n${JSON.stringify(redacted, null, 2)}`)
    return
  }
  if (sub === 'get') {
    const dotted = a.positionals[1]
    if (!dotted) throw new UsageError('usage: devctl config get <path>')
    const value = configPathGet(JSON.parse(fs.readFileSync(file, 'utf8')), dotted)
    if (value === undefined) throw new Error(`${dotted} is not set`)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    return
  }
  if (sub === 'set') {
    const dotted = a.positionals[1]
    const raw = a.positionals[2]
    if (!dotted || raw === undefined) throw new UsageError('usage: devctl config set <path> <value>')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    configPathSet(parsed, dotted, value)
    validateConfig(parsed)
    const tmp = `${file}.devctl-tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`)
    fs.renameSync(tmp, file)
    out(`set ${dotted}${typeof value === 'string' ? ` = ${value}` : ''}`)
    return
  }
  throw new UsageError('usage: devctl config show [--json] | config get <path> | config set <path> <value>')
}

function cmdContext(a: TArgs): void {
  const state = loadState()
  const name = a.positionals[0]
  if (!name) throw new UsageError('usage: devctl context <stack>')
  const def = state.stackDefs[name]
  if (!def) throw new UsageError(`unknown stack "${name}" - see devctl stack ls`)

  const lines = [
    `# devctl stack ${name}${def.label ? ` (${def.label})` : ''}`,
    `env: ${state.env}`,
    '',
  ]
  for (const [repo, target] of Object.entries(def.services)) {
    const row = Object.values(state.stacks).find((s) => s.repo === repo && s.worktree === target)
    if (target === 'test' || target === 'prod') {
      lines.push(`- ${repo}/${target}: external (${target})`)
      continue
    }
    const running = row ? (row.ref.workspaceId || row.ref.pid ? true : false) : false
    const url = row ? `, http://localhost:${row.port}` : ''
    lines.push(`- ${repo}/${target}: ${running ? 'running' : 'not running'}${url}`)
  }
  for (const row of Object.values(state.stacks)) {
    if (row.stack !== name) continue
    if (def.services[row.repo] === row.worktree) continue
    lines.push(`- ${row.repo}/${row.worktree}: shared dep, http://localhost:${row.port}`)
  }
  lines.push('', 'Logs: devctl logs <service>/<worktree> --lines 100. Health: devctl status --check.')
  console.log(lines.join('\n'))
}

const COMPLETION_COMMANDS = 'up down kill restart status which env use attach portless logs doctor config stack completion --version --help'

function cmdCompletion(a: TArgs): void {
  const shell = a.positionals[0]
  if (shell === 'zsh') {
    console.log(`#compdef devctl
_devctl() {
  local -a cmds
  cmds=(${COMPLETION_COMMANDS.split(' ').join(' ')})
  local -a services stacks
  services=(\${(f)"$(devctl _services 2>/dev/null)"})
  stacks=(\${(f)"$(devctl _stacks 2>/dev/null)"})
  local -a stack_subs=(ls up down add create delete current)
  if (( CURRENT == 2 )); then
    _describe -t commands 'devctl command' cmds
  elif (( CURRENT == 3 )); then
    case "$words[2]" in
      stack) _describe 'stack subcommand' stack_subs ;;
      up|down|use|restart) _describe 'target' services ;;
    esac
  elif (( CURRENT == 4 )); then
    case "$words[2]" in
      stack) case "$words[3]" in (up|down|add|create|delete|current) _describe 'stack' stacks ;; esac ;;
      use) _describe 'target value' services ;;
    esac
  fi
}
_devctl "$@"`)
    return
  }
  if (shell === 'bash') {
    console.log(`_devctl_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local services="$(devctl _services 2>/dev/null)"
  local stacks="$(devctl _stacks 2>/dev/null)"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMPLETION_COMMANDS}" -- "$cur") )
  elif [ "$prev" = "stack" ]; then
    COMPREPLY=( $(compgen -W "ls up down add create delete current" -- "$cur") )
  elif [ "$prev" = "up" ] || [ "$prev" = "down" ] || [ "$prev" = "use" ] || [ "$prev" = "restart" ]; then
    COMPREPLY=( $(compgen -W "$services" -- "$cur") )
  elif [ "$prev" = "add" ] || [ "$prev" = "create" ] || [ "$prev" = "delete" ]; then
    COMPREPLY=( $(compgen -W "$stacks" -- "$cur") )
  fi
}
complete -F _devctl_completions devctl`)
    return
  }
  throw new UsageError('usage: devctl completion bash|zsh')
}

function assertStackDeps(services: Partial<Record<string, string>>): void {
  for (const [svc, target] of Object.entries(services)) {
    if (target === 'test' || target === 'prod') continue
    for (const provider of providersOf(svc)) {
      if (isShared(provider)) continue
      if (!services[provider]) {
        throw new UsageError(
          `${svc} depends on "${provider}" - add it to the stack (head, a worktree name, test, or prod) via stack add/create`,
        )
      }
    }
  }
}

async function cmdStack(rawArgs: string[]): Promise<void> {
  const state = loadState()
  const sub = rawArgs[0]

  if (sub === 'ls' || sub === undefined) {
    const a = parseArgs(rawArgs.slice(1), { boolean: ['json'] }, 'stack ls')
    const names = Object.keys(state.stackDefs).sort()

    if (flag(a, 'json')) {
      const stacks = names.map((name) => {
        const def = state.stackDefs[name]
        const running = Object.values(state.stacks)
          .filter((s) => def.services[s.repo] === s.worktree)
          .map((s) => ({ key: s.key, port: s.port, url: s.url, portlessName: s.portlessName }))
        return { name, label: def.label, services: def.services, running, pinned: true }
      })
      console.log(JSON.stringify({ stacks }, null, 2))
      return
    }

    for (const name of names) {
      const def = state.stackDefs[name]
      const running = Object.values(state.stacks)
        .filter((s) => def.services[s.repo] === s.worktree)
        .map((s) => s.key)
      const services = repoKeysFromRegistry()
        .filter((r) => def.services[r])
        .map((r) => `${r}/${def.services[r]}`)
        .join(', ')
      const run = running.length > 0 ? colors.green(` [up: ${running.join(', ')}]`) : ''
      const label = def.label ? colors.dim(` ${def.label}`) : ''
      console.log(`${name.padEnd(40)} ${services}${label}${run}`)
    }
    if (names.length === 0) console.log(colors.dim('no stacks yet - create one with `devctl stack create` or Create Stack in Raycast'))
    return
  }

  if (sub === 'add') {
    const a = parseArgs(rawArgs.slice(1), {}, 'stack add')
    const [name, repo, wt] = a.positionals
    if (!name || !repo || !wt || a.positionals.length !== 3) throw new UsageError('usage: devctl stack add <name> <repo> <worktree|branch|test|prod|none>')
    if (!REPOS_SET.has(repo)) throw new UsageError(`unknown repo "${repo}"`)
    if (isShared(repo)) throw new UsageError(`"${repo}" is a shared service - it joins stacks automatically via dependsOn, not as a member`)
    if (wt !== 'none' && wt !== 'test' && wt !== 'prod') {
      findWorktree(repo as TRepoKey, wt)
    }
    const def = state.stackDefs[name] ?? { name, services: {} }
    if (wt === 'none') delete def.services[repo]
    else def.services[repo] = wt
    assertStackDeps(def.services)
    state.stackDefs[name] = def
    saveState(state)
    out(`${name}.${repo} → ${def.services[repo] ?? '(removed)'}`)
    return
  }

  if (sub === 'create') {
    const serviceNames = Object.keys(loadConfig().services)
    const a = parseArgs(rawArgs.slice(1), { string: ['label', ...serviceNames], boolean: ['yes', 'force'] }, 'stack create')
    const name = a.positionals[0]
    if (!name) throw new UsageError('usage: devctl stack create <name> [--label <text>] [--<service> <branch|test|prod|none> ...] [--yes]')
    if (a.positionals.length > 1) throw new UsageError(`unexpected argument "${a.positionals[1]}" (see "devctl stack create --help")`)
    const services: Partial<Record<string, string>> = {}
    for (const svc of serviceNames) {
      const value = opt(a, svc)
      if (value === undefined) continue
      if (isShared(svc)) throw new UsageError(`"${svc}" is a shared service - it joins stacks automatically via dependsOn, not as a member`)
      if (value === 'none') continue
      if (value !== 'test' && value !== 'prod') {
        services[svc] = createWorktree(svc, value).name
      } else {
        services[svc] = value
      }
    }
    if (Object.keys(services).length === 0) throw new UsageError('stack has no services')
    assertStackDeps(services)
    const label = opt(a, 'label')
    const existingDef = state.stackDefs[name]
    if (existingDef) {
      await confirmAction(a, `stack "${name}" already exists (${stackSummary(existingDef)}) - replace its definition?`)
    }
    state.stackDefs[name] = { name, services, label: label ?? existingDef?.label }
    saveState(state)
    out(`stack ${name} created: ${stackSummary({ services })}`)
    out(`start it with: devctl stack up ${name}`)
    return
  }

  if (sub === 'delete') {
    const a = parseArgs(rawArgs.slice(1), { boolean: ['yes', 'force', 'keep-worktrees'] }, 'stack delete')
    const name = a.positionals[0]
    if (!name || a.positionals.length > 1) {
      throw new UsageError('usage: devctl stack delete <name> [--yes] [--force] [--keep-worktrees]')
    }
    const def = state.stackDefs[name]
    if (!def) {
      throw new UsageError(`"${name}" is not a pinned stack - discovered stacks derive from worktrees and cannot be deleted`)
    }
    const keepWorktrees = flag(a, 'keep-worktrees')
    const force = flag(a, 'force')
    const members = repoKeysFromRegistry()
      .map((repo) => ({ repo, service: def.services[repo] }))
      .filter((m): m is { repo: TRepoKey; service: string } => Boolean(m.service && m.service !== 'test' && m.service !== 'prod' && !isShared(m.repo)))
    const removable = members.filter((m) => m.service !== 'head')
    await confirmAction(
      a,
      keepWorktrees
        ? `delete stack "${name}" (${stackSummary(def)})? Running members will be stopped; worktrees untouched`
        : `delete stack "${name}" (${stackSummary(def)})? Running members are stopped and their worktrees are removed: ${removable.map((m) => `${m.repo}/${m.service}`).join(', ') || '(none)'}. Branches are kept`,
    )
    for (const m of members) {
      if (state.stacks[`${m.repo}/${m.service}`]) stopRunningEntry(state, `${m.repo}/${m.service}`, force)
    }
    closeWorkspaceByLabel(name)
    delete state.stackDefs[name]
    saveState(state)
    if (keepWorktrees) {
      out(`stack ${name} deleted (worktrees untouched)`)
      return
    }
    for (const m of removable) {
      try {
        removeWorktree(m.repo, m.service, force)
        out(colors.green(`■ removed worktree ${m.repo}/${m.service}`))
      } catch (err) {
        console.error(
          colors.red(`devctl: could not remove ${m.repo}/${m.service}: ${err instanceof Error ? err.message : String(err)}`),
        )
        process.exitCode = 1
      }
    }
    out(`stack ${name} deleted`)
    return
  }

  throw new UsageError(`unknown stack subcommand "${sub}" (see "devctl stack --help")`)
}

function splitNotify(argv: string[]): { argv: string[]; notify: string | null } {
  const ni = argv.indexOf('--notify')
  if (ni === -1) return { argv, notify: null }
  return { argv: [...argv.slice(0, ni), ...argv.slice(ni + 2)], notify: argv[ni + 1] ?? 'devctl' }
}

const GLOBAL_USAGE = `usage: devctl <command>

  up [stack | repo[/branch] | --all] [--force] [--dry-run] [--json] [--quiet]
                                 start a stack, one service, a cwd target, or every current HEAD
                                 prints a summary: started / reused / restarted / failed
  down [stack | repo[/branch] | --all] [--force] [--json] [--quiet]
  kill [--yes] [--force] [--json]   kill switch: stop every service in every stack + shared services, with confirmation
  restart <stack | repo[/branch]> [--force]   stop then start a target
  status [--json] [--check]      --check exits 1 when a tracked service is unhealthy
  which [--json]                 every worktree with its assigned port
  env test|prod [--force] [--json]   switch external APIs; restarts wired/external services
  env show|set|unset|edit ...        inspect a service's effective env, or edit its stack overrides
  use <service> <branch|test|prod> [--force] [--json]
                                 point everything that depends on <service> at a target
  stack ls [--json] | up <name> | down <name>
  stack add <name> <repo> <branch|test|prod|none>
  stack create <name> [--label <text>] [--<service> <branch|test|prod|none> ...] [--yes]
                                 create worktrees as needed and pin the stack; replacing one asks for confirmation
  stack delete <name> [--yes] [--force] [--keep-worktrees]
                                 remove a pinned stack, its worktrees (branches are kept)
  logs <repo/branch> [--lines N] [--follow]
  diagnose <service>/<worktree> [--json]
                                 hand a service's recent logs to the debug agent for a root cause
  config show [--json]           resolved config with secrets redacted
  config get <path>              read one value (dotted path, e.g. debug.model)
  config set <path> <value>      write one value; validates before saving
  context [stack]                markdown status of a stack (default: current) for pasting to agents
  doctor [--json]                check config, binaries, repos, ports, env files, and state
  attach [workspace]             focus a herdr workspace
  portless on|off|status         start/stop the portless proxy (named URLs) and register routes
  completion bash|zsh            print shell completion script
  --version                      print devctl version

  Global flags: --no-color, --quiet. Every command accepts --help.
  Shared services (e.g. mongo) have no worktrees: start/stop with devctl up <name> / down <name>,
  or let the graph start them via dependsOn/wiring.`

const HELP: Record<string, string> = {
  up: `usage: devctl up [stack | repo[/branch] | --all] [--force] [--dry-run] [--json] [--quiet]

  No target: cwd-detect. Pass --all to start every current HEAD.
  --dry-run    print what would start (dependency order, ports) and exit
  --force      kill port occupants that get in the way (still ownership-checked)
  --json       machine-readable result: { started, reused, restarted, failed, ok }
  --quiet      suppress per-service progress lines`,
  down: `usage: devctl down [stack | repo[/branch] | --all] [--force] [--yes] [--json]

  --all is the kill switch: stops everything and asks for confirmation (--yes skips)`,
  kill: `usage: devctl kill [--yes] [--force] [--json]

  Stops every tracked service in every stack plus shared services. Asks for confirmation
  unless --yes. Non-interactive shells must pass --yes.`,
  restart: `usage: devctl restart <stack | repo[/branch]> [--force]

  Stops the target's members then starts them again with fresh env.`,
  status: `usage: devctl status [--json] [--check]

  --check exits 1 when any tracked service is unhealthy (for scripts/CI)`,
  which: `usage: devctl which [--json]`,
  env: `usage: devctl env test|prod [--force] [--json]
              devctl env show <service>[/<worktree>] [--stack <name>] [--json] [--reveal]
              devctl env set|unset <service> KEY[=VALUE] [--stack <name>] [--force]
              devctl env edit <service> [--stack <name>]

  test|prod switches the external API mode and restarts services with wiring or envExternals.
  show prints the effective env with the source of every value (base file, services.<x>.env,
  envExternals, wiring, stack override); secret-looking values are redacted unless --reveal.
  set/unset/edit maintain ~/.devctl/env/<stack>/<service>.env, which is layered last and
  applied on start (running members of that stack are restarted).`,
  use: `usage: devctl use <service> <branch|test|prod> [--force] [--json]

  Points every service that depends on <service> at the given target.
  Stack member overrides win over this.`,
  attach: `usage: devctl attach [workspace]`,
  logs: `usage: devctl logs <repo/branch> [--lines N] [--follow]

  --lines defaults to 50 (1..10000). --follow tails the log.`,
  diagnose: `usage: devctl diagnose <service>/<worktree> [--json]

  Runs the configured debug agent on the service's recent logs and prints ROOT CAUSE / FIX.
  Works whether the service is running, failed, or stopped. Configure via the "debug" block.`,
  doctor: `usage: devctl doctor [--json]`,
  config: `usage: devctl config show [--json] | config get <path> | config set <path> <value>

  show prints the resolved config with secret-looking values (KEY/TOKEN/SECRET/PASSWORD/DSN) redacted.
  get/set use dotted paths, e.g. "debug.model" or "services.deimos.env.PORT".
  set parses the value as JSON when possible (true/false/numbers), otherwise as a string.
  The config is validated before it is written; an invalid edit is rejected.`,
  context: `usage: devctl context [stack]

  Prints markdown describing the stack (services, targets, state, URLs) - paste it into an agent.
  Pass a stack name to target one.`,
  portless: `usage: devctl portless on [--port N] [--no-restart] [--force]
              devctl portless off [--no-restart] [--force]
              devctl portless status [--json]

  on starts the portless proxy and registers a route per running service; off stops the proxy
  and removes routes, so named URLs are replaced by http://localhost:<port>. Both restart the
  running services so their env reflects the mode, unless --no-restart is passed.
  status prints whether portless is installed, whether named URLs are on, and the active routes.
  Without portless, devctl stays on plain localhost ports.`,
  completion: `usage: devctl completion bash|zsh

  Print a completion script. zsh: eval "$(devctl completion zsh)". bash: eval "$(devctl completion bash)".`,
  stack: `usage: devctl stack <subcommand>

  ls [--json]        pinned stacks, services, running state
  up <name>          start a stack's members (graph deps auto-wire)
  down <name>        stop a stack's members
  add <name> <repo> <branch|test|prod|none>     pin/override a stack service
  create <name> [--label <text>] [--<service> <branch|test|prod|none> ...] [--yes]
  delete <name> [--yes] [--force] [--keep-worktrees]
                     remove a pinned stack; stops members and removes their worktrees
                     (branches are kept). --keep-worktrees leaves the worktrees in place`,
}

async function runCommand(rawArgv: string[]): Promise<void> {
  if (rawArgv.includes('--no-color')) setColorEnabled(false)
  if (rawArgv.includes('--quiet')) setQuiet(true)
  const argv = rawArgv.filter((a) => a !== '--no-color' && a !== '--quiet')
  const [command, ...args] = argv

  if (!command) {
    console.log(GLOBAL_USAGE)
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    console.log(pkg.version)
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP[command] ?? GLOBAL_USAGE)
    return
  }

  switch (command) {
    case 'up':
      return cmdUp(parseArgs(args, { boolean: ['force', 'all', 'dry-run', 'json'] }, 'up'))
    case 'down':
      return cmdDown(parseArgs(args, { boolean: ['all', 'yes', 'force', 'json'] }, 'down'))
    case 'kill': {
      const a = parseArgs(args, { boolean: ['yes', 'force', 'json'] }, 'kill')
      return cmdDown({ ...a, flags: { ...a.flags, all: true } })
    }
    case 'restart':
      return cmdRestart(parseArgs(args, { boolean: ['force'] }, 'restart'))
    case 'status':
      return cmdStatus(parseArgs(args, { boolean: ['json', 'check'] }, 'status'))
    case 'which':
      return cmdWhich(parseArgs(args, { boolean: ['json'] }, 'which'))
    case 'env':
      return cmdEnv(parseArgs(args, { string: ['stack'], boolean: ['force', 'json', 'reveal'] }, 'env'))
    case 'use':
      return cmdUse(parseArgs(args, { boolean: ['force', 'json'] }, 'use'))
    case 'stack':
      if (args[0] === 'up' || args[0] === 'down') {
        const [sub, ...rest] = args
        return sub === 'up'
          ? cmdUp(parseArgs(rest, { boolean: ['force', 'all', 'dry-run', 'json'] }, 'stack up'))
          : cmdDown(parseArgs(rest, { boolean: ['all', 'yes', 'force', 'json'] }, 'stack down'))
      }
      return cmdStack(args)
    case 'portless':
      return cmdPortless(parseArgs(args, { string: ['port'], boolean: ['json', 'force', 'no-restart'] }, 'portless'))
    case 'attach':
      return cmdAttach(parseArgs(args, {}, 'attach'))
    case 'logs':
      return cmdLogs(parseArgs(args, { string: ['lines'], boolean: ['follow'] }, 'logs'))
    case 'diagnose':
      return cmdDiagnose(parseArgs(args, { boolean: ['json'] }, 'diagnose'))
    case 'doctor':
      return cmdDoctor(parseArgs(args, { boolean: ['json'] }, 'doctor'))
    case 'config':
      return cmdConfig(parseArgs(args, { boolean: ['json'] }, 'config'))
    case 'context':
      return cmdContext(parseArgs(args, {}, 'context'))
    case 'completion':
      return cmdCompletion(parseArgs(args, {}, 'completion'))
    case '_services':
      console.log(Object.keys(loadConfig().services).join('\n'))
      return
    case '_stacks':
      console.log(Object.keys(loadState().stackDefs).join('\n'))
      return
    default:
      console.log(GLOBAL_USAGE)
      process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const { argv, notify } = splitNotify(process.argv.slice(2))
  try {
    await runCommand(argv)
    if (notify) systemNotify(process.exitCode === 1 ? `${notify} - failed (run devctl status)` : `${notify} - done`)
  } catch (err) {
    console.error(colors.red(`devctl: ${err instanceof Error ? err.message : String(err)}`))
    try {
      fs.mkdirSync(`${process.env.HOME}/.devctl/logs`, { recursive: true })
      fs.appendFileSync(
        `${process.env.HOME}/.devctl/logs/devctl.log`,
        `${new Date().toISOString()} ERROR ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      )
    } catch {}
    if (notify) systemNotify(`${notify} - failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`)
    process.exit(1)
  }
}

main()
