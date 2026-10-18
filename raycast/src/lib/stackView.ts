import type { TStackInfo, TStackStatus } from './devctl'

export type ServiceState = 'ready' | 'starting' | 'failed' | 'stopped' | 'external-test' | 'external-prod'

export interface ServiceView {
  repo: string
  target: string
  key: string
  state: ServiceState
  url: string | null
  local: boolean
}

const STARTING_GRACE_MS = 5 * 60_000

function startingStuck(startedAt: string | undefined): boolean {
  if (!startedAt) return false
  const ms = Date.now() - new Date(startedAt).getTime()
  return Number.isFinite(ms) && ms > STARTING_GRACE_MS
}

export interface StackView {
  id: string
  title: string
  services: ServiceView[]
  ready: number
  localTotal: number
  running: boolean
  state: 'ready' | 'starting' | 'failed' | 'stopped' | 'external'
}

function matchesTarget(member: TStackStatus['stacks'][number], target: string): boolean {
  return member.worktree === target
}

export function serviceStateLabel(state: ServiceState): string {
  switch (state) {
    case 'external-test': return 'External test'
    case 'external-prod': return 'External prod'
    case 'ready': return 'Ready'
    case 'starting': return 'Starting'
    case 'failed': return 'Failed'
    case 'stopped': return 'Stopped'
  }
}

export function stackView(stack: TStackInfo, status: TStackStatus | null): StackView {
  const services = Object.entries(stack.services).map(([repo, target]): ServiceView => {
    if (target === 'test' || target === 'prod') {
      return { repo, target, key: `${repo}/${target}`, state: `external-${target}`, url: null, local: false }
    }
    const runtime = status?.stacks.find(
      (member) => member.repo === repo && matchesTarget(member, target),
    )
    if (!runtime) return { repo, target, key: `${repo}/${target}`, state: 'stopped', url: null, local: true }
    const state = runtime.alive && runtime.listening ? 'ready' : runtime.alive ? (startingStuck(runtime.startedAt) ? 'failed' : 'starting') : 'failed'
    return { repo, target, key: runtime.key, state, url: runtime.portlessUrl ?? runtime.url, local: true }
  })

  const local = services.filter((service) => service.local)
  const ready = local.filter((service) => service.state === 'ready').length
  const running = local.some((service) => service.state !== 'stopped')
  const state = services.some((service) => service.state === 'failed')
    ? 'failed'
    : services.some((service) => service.state === 'starting')
      ? 'starting'
      : local.length === 0
        ? 'external'
        : ready === local.length
          ? 'ready'
          : 'stopped'

  return {
    id: stack.name,
    title: stack.label ?? stack.name,
    services,
    ready,
    localTotal: local.length,
    running,
    state,
  }
}
