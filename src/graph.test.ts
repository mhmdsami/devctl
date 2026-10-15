import assert from 'assert'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { assignSlots, createWorktree, removeWorktree, slotPort } from './registry'
import { setOverride, unsetOverride } from './envOverrides'
import { resolveEnv } from './stacks'

if (!process.env.DEVCTL_WORKTREES_ROOT) {
  throw new Error('graph.test.ts needs DEVCTL_WORKTREES_ROOT set (use `npm test`)')
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-test-')))
for (const repo of ['infra', 'api', 'web']) {
  const dir = path.join(root, repo)
  fs.mkdirSync(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, '.env.test'), 'API_URL=https://api.test.example.com\n')
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'])
}
const cfg = {
  reposRoot: root,
  herdr: { enabled: false, workspace: 'test' },
  envBaseFiles: { local: '.env.development', test: '.env.test', prod: '.env.production' },
  services: {
    mongo: { repo: 'infra', basePort: 27017, shared: true, command: 'true', healthTimeoutMs: 1000 },
    api: {
      repo: 'api',
      basePort: 3000,
      command: 'true',
      dependsOn: ['mongo'],
      provides: { url: 'http://localhost:${port}/api', selfUrl: 'https://${dnsName}.localhost', origin: '${origin}' },
      remoteProvides: { url: { from: 'web', envKey: 'API_URL' } },
      healthTimeoutMs: 1000,
    },
    web: { repo: 'web', basePort: 3100, command: 'true', wiring: { API_URL: 'api.url', SELF_URL: 'api.selfUrl', SELF_ORIGIN: 'api.origin' }, healthTimeoutMs: 1000 },
  },
}
fs.writeFileSync(path.join(root, 'devctl.config.json'), JSON.stringify(cfg, null, 2))
process.env.DEVCTL_CONFIG = path.join(root, 'devctl.config.json')

const { depsOf, dependentsOf, resolveWiring, targetFor } = await import('./stacks')
const { listWorktrees } = await import('./registry')

const state = { env: 'test' as const, targets: {} }

assert.deepStrictEqual(targetFor(state, 'web', 'api', { name: 's', services: { api: 'head' } }), { kind: 'local', name: 'head' })
assert.deepStrictEqual(targetFor({ env: 'prod', targets: {} }, 'web', 'api'), { kind: 'remote', mode: 'prod' })
assert.deepStrictEqual(targetFor({ env: 'test', targets: { web: 'api/ft-x' } }, 'web', 'api'), { kind: 'local', name: 'ft-x' })

assert.deepStrictEqual(dependentsOf('api').sort(), ['web'])
assert.deepStrictEqual(dependentsOf('mongo'), ['api'])
assert.deepStrictEqual(dependentsOf('web'), [])

assert.deepStrictEqual(depsOf(state, 'api'), [{ kind: 'service', repo: 'mongo', worktree: null }])
assert.deepStrictEqual(depsOf(state, 'web'), [])
const localWeb = { ...state, targets: { web: 'api/head' } }
assert.deepStrictEqual(depsOf(localWeb, 'web'), [{ kind: 'service', repo: 'api', worktree: 'head' }])

const dbWts = listWorktrees('mongo')
assert.strictEqual(dbWts.length, 1)
assert.strictEqual(dbWts[0].port, 27017)
assert.strictEqual(dbWts[0].name, 'head')

const remote = resolveWiring({ env: 'test', targets: {} }, 'web')
assert.strictEqual(remote.API_URL, 'https://api.test.example.com')

const local = resolveWiring({ env: 'test', targets: { web: 'api/head' } }, 'web')
assert.strictEqual(local.API_URL, 'http://localhost:3000/api')
assert.strictEqual(local.SELF_URL, 'https://head.api.localhost')

const portsOnly = resolveWiring({ env: 'test', targets: { web: 'api/head' }, portless: false }, 'web')
assert.strictEqual(portsOnly.SELF_ORIGIN, 'http://localhost:3000')
assert.strictEqual(portsOnly.SELF_URL, 'https://head.api.localhost')

const basePort = 6007
const running = { 'espeon/ft-configurable-text-banner': 6017, 'espeon/ho-lfc-qa': 6018 }
const pinned = assignSlots(['espeon/head', 'espeon/ft-configurable-text-banner', 'espeon/ho-lfc-qa'], running, {}, basePort)
assert.strictEqual(pinned['espeon/head'], 0)
assert.strictEqual(pinned['espeon/ho-lfc-qa'], 2)

const shifted = assignSlots(
  ['espeon/head', 'espeon/ft-configurable-text-banner', 'espeon/ft-product-card-carousel', 'espeon/ho-lfc-qa'],
  running,
  pinned,
  basePort,
)
assert.strictEqual(shifted['espeon/ho-lfc-qa'], 2)
assert.strictEqual(slotPort(basePort, shifted['espeon/ho-lfc-qa']!), 6018)
assert.strictEqual(shifted['espeon/ft-product-card-carousel'], 3)
assert.strictEqual(slotPort(basePort, shifted['espeon/ft-product-card-carousel']!), 6019)

const afterStop = assignSlots(['espeon/head', 'espeon/ft-product-card-carousel', 'espeon/ho-lfc-qa'], {}, shifted, basePort)
assert.strictEqual(afterStop['espeon/ft-product-card-carousel'], 3)
assert.strictEqual(afterStop['espeon/ho-lfc-qa'], 2)

const apiHead = listWorktrees('api').find((t) => t.name === 'head')!
setOverride('s', 'api', 'API_URL', 'from-override')
const resolved = resolveEnv('api', apiHead, { env: 'test', targets: {} }, { name: 's', services: { api: 'head' } })
assert.strictEqual(resolved.env.API_URL, 'from-override')
assert.match(resolved.display.API_URL.source, /override s\/api\.env/)
unsetOverride('s', 'api', 'API_URL')
assert.strictEqual(resolveEnv('api', apiHead, { env: 'test', targets: {} }, { name: 's', services: { api: 'head' } }).env.API_URL, undefined)

const created = createWorktree('api', 'ft-temp-worktree')
assert.ok(fs.existsSync(created.path))
assert.ok(listWorktrees('api').some((t) => t.name === 'ft-temp-worktree'))
removeWorktree('api', 'ft-temp-worktree')
assert.ok(!listWorktrees('api').some((t) => t.name === 'ft-temp-worktree'))
assert.ok(!fs.existsSync(created.path))
assert.throws(() => removeWorktree('api', 'head'))

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(process.env.DEVCTL_WORKTREES_ROOT!, { recursive: true, force: true })
fs.rmSync(process.env.DEVCTL_DIR!, { recursive: true, force: true })
console.log('graph self-check passed')
