import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TDevctlState } from './state'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-store-'))
process.env.DEVCTL_DIR = dir

const store = await import('./store')
const { loadState, saveState } = await import('./state')

function entry(repo: string, worktree: string, port: number) {
  return {
    key: `${repo}/${worktree}`,
    repo,
    worktree,
    branch: null,
    ref: { port },
    port,
    url: `http://localhost:${port}`,
    startedAt: String(port),
  }
}

assert.deepStrictEqual(Object.keys(loadState().stacks), [], 'fresh store is empty')

const seed = loadState()
seed.stacks['payload/head'] = entry('payload', 'head', 3000)
saveState(seed)
assert.deepStrictEqual(loadState().stacks['payload/head'], entry('payload', 'head', 3000), 'round-trips a stack entry')

const a = loadState()
const b = loadState()
a.stacks['kirby/ft-x'] = entry('kirby', 'ft-x', 3100)
b.stacks['deimos/ft-y'] = entry('deimos', 'ft-y', 4000)
saveState(a)
saveState(b)
const merged = loadState()
assert.ok(merged.stacks['payload/head'], 'concurrent writer A does not clobber the seed')
assert.ok(merged.stacks['kirby/ft-x'], 'concurrent writer A survives writer B')
assert.ok(merged.stacks['deimos/ft-y'], 'concurrent writer B survives writer A')

const meta = loadState()
meta.env = 'prod'
saveState(meta)
assert.strictEqual(loadState().env, 'prod', 'meta changes persist')

const removed = loadState()
delete removed.stacks['kirby/ft-x']
saveState(removed)
assert.ok(!loadState().stacks['kirby/ft-x'], 'deletes persist')

fs.appendFileSync(store.STATE_FILE, 'this line is not json\n')
fs.appendFileSync(store.STATE_FILE, JSON.stringify({ op: 'put', ns: 'stacks', key: 'x/y', val: entry('x', 'y', 1) }) + '\n')
const salvaged = loadState()
assert.ok(salvaged.stacks['payload/head'], 'salvages records before a corrupt line')
assert.ok(!salvaged.stacks['x/y'], 'drops records after a corrupt line')
assert.ok(
  fs.readdirSync(dir).some((name) => name.startsWith('state.jsonl.corrupt-')),
  'quarantines the corrupt log',
)

fs.appendFileSync(store.STATE_FILE, '{"op":"put","ns":"stacks","key":"torn"\n')
assert.ok(loadState().stacks['payload/head'], 'ignores a torn final record')

fs.rmSync(store.STATE_FILE, { force: true })
fs.writeFileSync(
  store.LEGACY_STATE_FILE,
  JSON.stringify({ version: 2, stacks: { 'payload/head': entry('payload', 'head', 3000) }, env: 'test', targets: {}, stackDefs: {}, slots: {} }),
)
const migrated = loadState()
assert.ok(migrated.stacks['payload/head'], 'imports the legacy state.json')
assert.ok(fs.existsSync(store.STATE_FILE), 'writes the JSONL log on migration')
assert.ok(fs.existsSync(`${store.LEGACY_STATE_FILE}.bak`), 'keeps the legacy file as .bak')
assert.ok(!fs.existsSync(store.LEGACY_STATE_FILE), 'renames the legacy file away')

fs.rmSync(dir, { recursive: true, force: true })
console.log('store self-check passed')
