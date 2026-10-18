import assert from 'assert'
import { detectAgent, detectSessionId, inferSession } from './current'
import type { TAgentSession } from './types'

function session(agent: string, id: string, cwd: string, updatedAt: string): TAgentSession {
  return { agent, id, cwd, branches: [], title: '', path: '', updatedAt }
}

assert.strictEqual(detectAgent({ OPENCODE: '1' }), 'opencode')
assert.strictEqual(detectAgent({ AI_AGENT: 'opencode' }), 'opencode')
assert.strictEqual(detectAgent({ CLAUDECODE: '1' }), 'claude')
assert.strictEqual(detectAgent({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude')
assert.strictEqual(detectAgent({}), null)

assert.strictEqual(detectSessionId('opencode', { OPENCODE_SESSION_ID: 'ses_x' }), 'ses_x')
assert.strictEqual(detectSessionId('claude', { CLAUDE_SESSION_ID: 'uuid' }), 'uuid')
assert.strictEqual(detectSessionId('codex', { CODEX_HOME: '/tmp' }), null)

const sessions = [
  session('claude', 'a', '/repo', '2026-10-18T10:00:00.000Z'),
  session('codex', 'b', '/repo', '2026-10-18T12:00:00.000Z'),
  session('pi', 'c', '/other', '2026-10-18T11:00:00.000Z'),
]
assert.strictEqual(inferSession(null, '/repo', sessions)?.id, 'b')
assert.strictEqual(inferSession('claude', '/repo', sessions)?.id, 'a')
assert.strictEqual(inferSession('pi', '/elsewhere', sessions)?.id, 'c')
assert.strictEqual(inferSession('claude', '/nowhere', sessions)?.id, 'a')

console.log('agents self-check passed')
