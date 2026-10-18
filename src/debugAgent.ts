import { execFileSync, spawn } from 'child_process'
import { loadConfig } from './config'
import { commandEnv, shQuote } from './process'
import { colors, quiet } from './util'

const DEFAULT_PROVIDER = 'opencode-go'
const DEFAULT_MODEL = 'omen-alpha'

export function debugCommand(): string | null {
  const dbg = loadConfig().debug
  if (!dbg?.enabled) return null
  if (dbg.command?.trim()) return dbg.command.trim()
  const provider = dbg.provider?.trim() || DEFAULT_PROVIDER
  const model = dbg.model?.trim() || DEFAULT_MODEL
  return `pi --provider ${provider} --model ${model} -p --no-session --tools read,bash`
}
const runExclusive = (() => {
  let chain: Promise<void> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
})()

function buildPrompt(info: TDebugInfo): string {
  const tail = info.output.trim()
  const output = tail.length > 8_000 ? `…\n${tail.slice(tail.length - 8_000)}` : tail
  return [
    `Diagnose the devctl-managed service "${info.key}" (port ${info.port}).`,
    `Start command (run from ${info.cwd}): ${info.cmd}`,
    'Its last output:',
    output || '(no output captured)',
    '',
    'Diagnose the root cause. You may read files and run read-only commands in the worktree.',
    'Do NOT modify files, install dependencies, or start/stop processes.',
    'Answer in exactly this format:',
    'ROOT CAUSE: <one sentence>',
    'FIX: <one or two concrete steps>',
  ].join('\n')
}

function spawnAgent(info: TDebugInfo, command: string, stream: boolean): Promise<string> {
  const bin = command.split(/\s+/)[0]
  const env = commandEnv()
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 2_000, env })
  } catch {
    console.error(colors.dim(`debug agent: "${bin}" not found in PATH - skipping diagnosis`))
    return Promise.resolve('')
  }

  return new Promise<string>((resolve) => {
    let text = ''
    const child = spawn('bash', ['-c', `${command} ${shQuote(buildPrompt(info))}`], {
      cwd: info.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const handle = (chunk: Buffer): void => {
      text += chunk.toString()
      if (stream) process.stdout.write(chunk)
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    const timer = setTimeout(() => {
      console.error(colors.dim('debug agent: timed out after 180s'))
      child.kill('SIGTERM')
    }, 180_000)
    const onSignal = (): void => {
      child.kill('SIGTERM')
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    child.on('exit', () => {
      clearTimeout(timer)
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      resolve(text.trim())
    })
    child.on('error', (err) => {
      console.error(colors.dim(`debug agent: ${err.message}`))
      clearTimeout(timer)
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      resolve(text.trim())
    })
  })
}

export interface TDebugInfo {
  key: string
  cmd: string
  port: number
  cwd: string
  output: string
}

export async function debugFailure(info: TDebugInfo): Promise<void> {
  if (quiet()) return
  const command = debugCommand()
  if (!command) return
  console.log(colors.yellow(`→ asking ${command.split(/\s+/)[0]} to diagnose ${info.key}…`))
  await runExclusive(() => spawnAgent(info, command, true))
}

export async function runDiagnosis(info: TDebugInfo): Promise<string> {
  const command = debugCommand()
  if (!command) throw new Error('debug agent is not enabled in devctl.config.json')
  return runExclusive(() => spawnAgent(info, command, !quiet()))
}
