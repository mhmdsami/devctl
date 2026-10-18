import type { TDevctlConfig } from './config'

export class ConfigError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`config: ${path}: ${message}`)
  }
}

const ENVS = ['local', 'test', 'prod'] as const

export function validateConfig(cfg: unknown): TDevctlConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new ConfigError('$', 'expected an object')
  }
  const c = cfg as Record<string, unknown>
  if (c.version !== undefined && (typeof c.version !== 'number' || !Number.isInteger(c.version) || c.version < 1)) {
    throw new ConfigError('version', 'expected a positive integer when set')
  }
  requireString(c, 'reposRoot')
  requireObject(c, 'herdr')
  const herdr = c.herdr as Record<string, unknown>
  if (typeof herdr.enabled !== 'boolean') throw new ConfigError('herdr.enabled', 'expected boolean')
  if (typeof herdr.workspace !== 'string') throw new ConfigError('herdr.workspace', 'expected string')
  requireObject(c, 'envBaseFiles')
  const ebf = c.envBaseFiles as Record<string, unknown>
  for (const k of ENVS) {
    if (typeof ebf[k] !== 'string') throw new ConfigError(`envBaseFiles.${k}`, `expected string (one of ${ENVS.join('|')})`)
  }
  if (c.db !== undefined) {
    throw new ConfigError('db', 'the db block was removed - define shared services under services.*.shared instead')
  }
  if (c.debug !== undefined) {
    if (typeof c.debug !== 'object' || c.debug === null) throw new ConfigError('debug', 'expected object')
    const d = c.debug as Record<string, unknown>
    if (d.enabled !== undefined && typeof d.enabled !== 'boolean') throw new ConfigError('debug.enabled', 'expected boolean')
    if (d.command !== undefined && (typeof d.command !== 'string' || !d.command.trim())) {
      throw new ConfigError('debug.command', 'expected non-empty string when set')
    }
    if (d.provider !== undefined && (typeof d.provider !== 'string' || !d.provider.trim())) {
      throw new ConfigError('debug.provider', 'expected non-empty string when set')
    }
    if (d.model !== undefined && (typeof d.model !== 'string' || !d.model.trim())) {
      throw new ConfigError('debug.model', 'expected non-empty string when set')
    }
  }
  requireObject(c, 'services')
  const services = c.services as Record<string, unknown>
  if (Object.keys(services).length === 0) throw new ConfigError('services', 'must define at least one service')
  for (const [name, raw] of Object.entries(services)) validateService(services, name, raw)
  validateGraph(services)
  return c as unknown as TDevctlConfig
}

function validateDb(raw: unknown): void {
  if (!raw || typeof raw !== 'object') throw new ConfigError('db', 'expected object')
  const d = raw as Record<string, unknown>
  if (typeof d.dir !== 'string') throw new ConfigError('db.dir', 'expected string')
  if (!Array.isArray(d.files) || d.files.length === 0 || !d.files.every((f) => typeof f === 'string')) {
    throw new ConfigError('db.files', 'expected non-empty array of strings')
  }
  if (!Array.isArray(d.services) || d.services.length === 0 || !d.services.every((s) => typeof s === 'string')) {
    throw new ConfigError('db.services', 'expected non-empty array of strings')
  }
  if (d.statusFilter !== undefined && typeof d.statusFilter !== 'string') {
    throw new ConfigError('db.statusFilter', 'expected string')
  }
}

function validateService(services: Record<string, unknown>, name: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`services.${name}`, 'expected object')
  const s = raw as Record<string, unknown>
  requireString(s, 'services.' + name + '.repo')
  if (typeof s.basePort !== 'number' || s.basePort <= 0) throw new ConfigError(`services.${name}.basePort`, 'expected positive number')
  if (s.inspectBasePort !== undefined && (typeof s.inspectBasePort !== 'number' || s.inspectBasePort <= 0)) {
    throw new ConfigError(`services.${name}.inspectBasePort`, 'expected positive number when set')
  }
  if (typeof s.command !== 'string' || !s.command) throw new ConfigError(`services.${name}.command`, 'expected non-empty string')
  if (s.healthCommand !== undefined && (typeof s.healthCommand !== 'string' || !s.healthCommand.trim())) {
    throw new ConfigError(`services.${name}.healthCommand`, 'expected non-empty string when set')
  }
  if (typeof s.healthTimeoutMs !== 'number' || s.healthTimeoutMs <= 0) {
    throw new ConfigError(`services.${name}.healthTimeoutMs`, 'expected positive number')
  }
  if (s.shared !== undefined && typeof s.shared !== 'boolean') throw new ConfigError(`services.${name}.shared`, 'expected boolean')
  if (s.install !== undefined && (typeof s.install !== 'string' || !s.install.trim())) {
    throw new ConfigError(`services.${name}.install`, 'expected non-empty string when set')
  }
  if (s.stopCommand !== undefined && (typeof s.stopCommand !== 'string' || !s.stopCommand)) {
    throw new ConfigError(`services.${name}.stopCommand`, 'expected non-empty string when set')
  }
  if (s.logsCommand !== undefined && (typeof s.logsCommand !== 'string' || !s.logsCommand.trim())) {
    throw new ConfigError(`services.${name}.logsCommand`, 'expected non-empty string when set')
  }
  if (s.requires !== undefined) {
    throw new ConfigError(`services.${name}.requires`, 'removed - express infra deps via dependsOn/wiring to a shared service')
  }
  if (s.env !== undefined && (typeof s.env !== 'object' || s.env === null)) {
    throw new ConfigError(`services.${name}.env`, 'expected object')
  }
  if (s.envExternals !== undefined) {
    if (typeof s.envExternals !== 'object' || s.envExternals === null) {
      throw new ConfigError(`services.${name}.envExternals`, 'expected object')
    }
    for (const mode of Object.keys(s.envExternals as Record<string, unknown>)) {
      if (!ENVS.includes(mode as (typeof ENVS)[number]) || mode === 'local') {
        throw new ConfigError(`services.${name}.envExternals.${mode}`, `expected one of test|prod`)
      }
    }
  }
  if (s.provides !== undefined) {
    if (typeof s.provides !== 'object' || s.provides === null) throw new ConfigError(`services.${name}.provides`, 'expected object')
    for (const [k, v] of Object.entries(s.provides as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new ConfigError(`services.${name}.provides.${k}`, 'expected string template')
    }
  }
  if (s.remoteProvides !== undefined) {
    if (typeof s.remoteProvides !== 'object' || s.remoteProvides === null) {
      throw new ConfigError(`services.${name}.remoteProvides`, 'expected object')
    }
    for (const [k, v] of Object.entries(s.remoteProvides as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') throw new ConfigError(`services.${name}.remoteProvides.${k}`, 'expected { from, envKey }')
      const rs = v as Record<string, unknown>
      if (typeof rs.from !== 'string') throw new ConfigError(`services.${name}.remoteProvides.${k}.from`, 'expected string (service name)')
      if (!(rs.from in services)) throw new ConfigError(`services.${name}.remoteProvides.${k}.from`, `unknown service "${rs.from}"`)
      if (typeof rs.envKey !== 'string') throw new ConfigError(`services.${name}.remoteProvides.${k}.envKey`, 'expected string')
    }
  }
  if (s.wiring !== undefined) {
    if (typeof s.wiring !== 'object' || s.wiring === null) throw new ConfigError(`services.${name}.wiring`, 'expected object')
    for (const [envKey, ref] of Object.entries(s.wiring as Record<string, unknown>)) {
      if (typeof ref !== 'string' || !ref.includes('.')) {
        throw new ConfigError(`services.${name}.wiring.${envKey}`, 'expected "<service>.<value>" reference')
      }
      const [provider, value] = ref.split('.', 2)
      if (!(provider in services)) throw new ConfigError(`services.${name}.wiring.${envKey}`, `unknown service "${provider}"`)
      if (provider === name) throw new ConfigError(`services.${name}.wiring.${envKey}`, 'a service cannot wire to itself')
    }
  }
  if (s.dependsOn !== undefined) {
    if (!Array.isArray(s.dependsOn) || !s.dependsOn.every((d) => typeof d === 'string')) {
      throw new ConfigError(`services.${name}.dependsOn`, 'expected array of service names')
    }
    for (const dep of s.dependsOn as string[]) {
      if (!(dep in services)) throw new ConfigError(`services.${name}.dependsOn`, `unknown service "${dep}"`)
      if (dep === name) throw new ConfigError(`services.${name}.dependsOn`, 'a service cannot depend on itself')
    }
  }
  if (s.overlayManagedKeys !== undefined && (!Array.isArray(s.overlayManagedKeys) || !s.overlayManagedKeys.every((k) => typeof k === 'string'))) {
    throw new ConfigError(`services.${name}.overlayManagedKeys`, 'expected array of strings')
  }
}

function requireString(o: Record<string, unknown>, path: string): void {
  if (typeof o[path.split('.').pop()!] !== 'string') throw new ConfigError(path, 'expected string')
}

function requireObject(o: Record<string, unknown>, path: string): void {
  if (typeof o[path.split('.').pop()!] !== 'object' || o[path.split('.').pop()!] === null) {
    throw new ConfigError(path, 'expected object')
  }
}

function edgesOf(services: Record<string, unknown>, name: string): string[] {
  const s = services[name] as Record<string, unknown>
  const out = new Set<string>()
  if (s.wiring && typeof s.wiring === 'object') {
    for (const ref of Object.values(s.wiring as Record<string, unknown>)) out.add(String(ref).split('.', 2)[0])
  }
  if (Array.isArray(s.dependsOn)) for (const d of s.dependsOn) out.add(d)
  return [...out]
}

function validateGraph(services: Record<string, unknown>): void {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (name: string): void => {
    const st = state.get(name)
    if (st === 2) return
    if (st === 1) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ')
      throw new ConfigError('services', `dependency cycle: ${cycle}`)
    }
    state.set(name, 1)
    stack.push(name)
    for (const dep of edgesOf(services, name)) visit(dep)
    stack.pop()
    state.set(name, 2)
  }
  for (const name of Object.keys(services)) visit(name)

  for (const [name, raw] of Object.entries(services)) {
    const s = raw as Record<string, unknown>
    if (s.wiring && typeof s.wiring === 'object') {
      for (const [envKey, ref] of Object.entries(s.wiring as Record<string, unknown>)) {
        const [provider, value] = String(ref).split('.', 2)
        const ps = services[provider] as Record<string, unknown>
        const hasLocal = ps.provides && typeof ps.provides === 'object' && value in (ps.provides as Record<string, unknown>)
        const hasRemote = ps.remoteProvides && typeof ps.remoteProvides === 'object' && value in (ps.remoteProvides as Record<string, unknown>)
        if (!hasLocal && !hasRemote) {
          throw new ConfigError(`services.${name}.wiring.${envKey}`, `"${provider}" provides no value "${value}" (define services.${provider}.provides.${value} or .remoteProvides.${value})`)
        }
      }
    }
  }
}
