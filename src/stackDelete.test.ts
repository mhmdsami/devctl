import assert from 'assert'
import { stackDeletePlan } from './stackRegistry'

const stacks = {
  'payload/head': { repo: 'payload', stack: 's' },
  'payload-worker/head': { repo: 'payload-worker', stack: 's' },
  'kirby/ft-x': { repo: 'kirby', stack: 's' },
  'mongo/head': { repo: 'mongo', stack: 's' },
  'web/head': { repo: 'web', stack: 'other' },
  'orphan/head': { repo: 'orphan' },
}

const isShared = (repo: string): boolean => repo === 'mongo'
const plan = stackDeletePlan(stacks, 's', ['payload/head', 'kirby/ft-x', 'gone/head'], isShared)

assert.deepStrictEqual(
  plan.stop.slice().sort(),
  ['kirby/ft-x', 'payload-worker/head', 'payload/head'],
  'stops pinned members plus every non-shared entry tagged with the stack',
)
assert.deepStrictEqual(plan.untag, ['mongo/head'], 'leaves shared entries running but untagged')
assert.ok(!plan.stop.includes('web/head'), 'does not stop another stack')
assert.ok(!plan.stop.includes('orphan/head'), 'does not stop untagged entries')
assert.ok(!plan.stop.includes('gone/head'), 'ignores a pinned key with no state entry')

const untagged = stackDeletePlan({ 'mongo/head': { repo: 'mongo' } }, 's', [], isShared)
assert.deepStrictEqual(untagged, { stop: [], untag: [] }, 'ignores entries that are already untagged')

console.log('stack delete self-check passed')
