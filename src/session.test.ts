import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-session-'))
process.env.HOME = home

const { removeSessionFiles } = await import('./session')

const key = 'payload/ft-x/wt'
const stem = key.replace(/\//g, '__')
const log = path.join(home, '.devctl', 'logs', `${stem}.log`)
const rotated = `${log}.1`
const script = path.join(home, '.devctl', 'scripts', `${stem}.sh`)

for (const file of [log, rotated, script]) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x')
}

removeSessionFiles(key)

assert.ok(!fs.existsSync(log), 'removes the log')
assert.ok(!fs.existsSync(rotated), 'removes the rotated log')
assert.ok(!fs.existsSync(script), 'removes the generated pane script')

const custom = path.join(home, 'elsewhere', 'custom.log')
fs.mkdirSync(path.dirname(custom), { recursive: true })
fs.writeFileSync(custom, 'x')
removeSessionFiles('other/wt', custom)
assert.ok(!fs.existsSync(custom), 'removes a custom log path')

fs.rmSync(home, { recursive: true, force: true })
console.log('session self-check passed')
