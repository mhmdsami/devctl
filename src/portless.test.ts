import assert from 'assert'

const { parseRoutesOutput } = await import('./portless')

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

console.log('portless self-check passed')
