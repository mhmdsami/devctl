import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-usage-'))
process.env.DEVCTL_DIR = dir

const { recordUsage, summarizeUsage, USAGE_FILE } = await import('./usage')

recordUsage(['status', '--json'], true, 12)
recordUsage(['status', '--json'], true, 9)
recordUsage(['stack', 'up', 'ft-x'], true, 400)
recordUsage(['env', 'bogus'], false, 3)
recordUsage(['--help'], true, 1)
recordUsage(['_services'], true, 1)

const summary = summarizeUsage()
const byKey = new Map(summary.map((entry) => [`${entry.cmd}${entry.sub ? ` ${entry.sub}` : ''}`, entry]))

assert.strictEqual(byKey.get('status')?.count, 2, 'groups repeated commands')
assert.strictEqual(byKey.get('stack up')?.count, 1, 'records subcommands')
assert.strictEqual(byKey.get('env')?.count, 1, 'ignores an unknown subcommand token')
assert.strictEqual(byKey.get('env')?.ok, 0, 'records failures')
assert.ok(!byKey.has('--help'), 'skips flag-only invocations')
assert.ok(!byKey.has('_services'), 'skips internal commands')
assert.ok(fs.existsSync(USAGE_FILE), 'writes the usage file')

fs.rmSync(dir, { recursive: true, force: true })
console.log('usage self-check passed')
