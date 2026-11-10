import assert from 'assert'
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'

const { auditPortlessState, parseRoutesOutput, proxyPort } = await import('./portless')
const { httpsReachable } = await import('./process')

const out = [
  '',
  'Active routes:',
  '',
  '  https://ft-soft-delete-admin-ui.payload.localhost:1355  ->  localhost:4808  (pid 90209)',
  '  http://app.localhost  ->  localhost:3000  (alias)',
  `  ${'\x1b[32m'}https://plain.localhost:8443  ->  localhost:5555${'\x1b[0m'}`,
  '',
].join('\n')

const routes = parseRoutesOutput(out)

assert.deepStrictEqual(
  routes,
  [
    { host: 'ft-soft-delete-admin-ui.payload.localhost', port: 4808, kind: 'pid 90209' },
    { host: 'app.localhost', port: 3000, kind: 'alias' },
    { host: 'plain.localhost', port: 5555, kind: 'app' },
  ],
  'parses hosts without the proxy port',
)

assert.deepStrictEqual(parseRoutesOutput(''), [], 'returns no routes for empty output')

const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-portless-port-'))
const previousStateDir = process.env.PORTLESS_STATE_DIR
process.env.PORTLESS_STATE_DIR = portDir
assert.strictEqual(proxyPort(), 1355, 'defaults to the devctl proxy port')
fs.writeFileSync(path.join(portDir, 'proxy.port'), '9999\n')
assert.strictEqual(proxyPort(), 9999, 'reads the active proxy port')
if (previousStateDir === undefined) delete process.env.PORTLESS_STATE_DIR
else process.env.PORTLESS_STATE_DIR = previousStateDir
fs.rmSync(portDir, { recursive: true, force: true })

const uid = process.getuid?.() ?? 0
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-portless-state-'))
fs.mkdirSync(path.join(state, 'host-certs'))
fs.writeFileSync(path.join(state, 'ca.pem'), 'ca')
fs.writeFileSync(path.join(state, 'ca.srl'), '1')
fs.writeFileSync(path.join(state, 'host-certs', 'good.pem'), 'cert')
fs.writeFileSync(path.join(state, 'host-certs', 'empty.pem'), '')

assert.deepStrictEqual(auditPortlessState(state, uid).map((issue) => issue.name), ['portless:certs'], 'flags empty certificates')
const foreign = auditPortlessState(state, uid + 1)
assert.deepStrictEqual(foreign.map((issue) => issue.name), ['portless:owner', 'portless:certs'], 'flags files owned by another user')
assert.ok(foreign[1].detail.includes('empty.pem'), 'names the empty certificate')
fs.chmodSync(path.join(state, 'ca.srl'), 0o444)
assert.deepStrictEqual(auditPortlessState(state, uid).map((issue) => issue.name), ['portless:ca-srl', 'portless:certs'], 'flags an unwritable ca.srl')
fs.chmodSync(path.join(state, 'ca.srl'), 0o644)
assert.deepStrictEqual(auditPortlessState(path.join(state, 'missing'), uid), [], 'ignores a missing state directory')
fs.rmSync(state, { recursive: true, force: true })

const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctl-tls-'))
const keyFile = path.join(tlsDir, 'key.pem')
const certFile = path.join(tlsDir, 'cert.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
const secure = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (_req, response) => {
  response.writeHead(204)
  response.end()
})
await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
const securePort = (secure.address() as { port: number }).port
assert.strictEqual(await httpsReachable('127.0.0.1', securePort, 1_000), true, 'accepts a TLS response')
await new Promise<void>((resolve) => secure.close(() => resolve()))

const plain = http.createServer((_req, response) => {
  response.writeHead(200)
  response.end()
})
await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
const plainPort = (plain.address() as { port: number }).port
assert.strictEqual(await httpsReachable('127.0.0.1', plainPort, 1_000), false, 'rejects a plain HTTP port')
await new Promise<void>((resolve) => plain.close(() => resolve()))
assert.strictEqual(await httpsReachable('127.0.0.1', plainPort, 500), false, 'rejects a closed port')
fs.rmSync(tlsDir, { recursive: true, force: true })

console.log('portless self-check passed')
