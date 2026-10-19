// node src/next/screens/hardware/parts/family.test.js — upstream dingoFW gating helpers
import assert from 'node:assert/strict'
import { has, hasBlock, lacks, olderThan, isUpstream, driveCaps } from './util.js'

const fork = { family: 'fork', version: 'v5.5.112' }
const up = { family: 'upstream', version: 'v0.6.3', paramRuns: [[0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8], [0x1000, 8, 0, 1, 2], [0x1a00, 8, 0, 1, 2, 3, 4]] }
const upUnread = { family: 'upstream', version: 'v0.6.3', paramRuns: null }

assert.equal(isUpstream(up), true)
assert.equal(olderThan(up.version, [5, 6, 0]), false)   // another line, not "older"
assert.equal(olderThan(fork.version, [5, 6, 0]), true)

assert.equal(has(up, 0x1007, 2), true)
assert.equal(has(up, 0x1007, 18), false)   // fork-only warn limit
assert.equal(has(up, 0x1008, 0), false)
assert.equal(has(fork, 0x1000, 18), true)  // fork: gate by version instead
assert.equal(has(upUnread, 0x1000, 18), true)

assert.equal(hasBlock(up, 0x1a00), true)
assert.equal(hasBlock(up, 0x1c00), false)

assert.equal(lacks(up, [5, 6, 0], 0x1c00), true)       // no math block
assert.equal(lacks(up, [5, 6, 0], 0x1a00), false)
assert.equal(lacks(up, [5, 6, 0]), true)               // fork-only command
assert.equal(lacks(upUnread, [5, 6, 0], 0x1a00), true) // not read yet
assert.equal(lacks(up, [5, 6, 0], 0x1000, 2), false)
assert.equal(lacks(fork, [5, 6, 0], 0x1c00), true)
assert.equal(lacks({ family: 'fork', version: 'v5.6.6' }, [5, 6, 0], 0x1c00), false)

// drive card: CANBoard DO PWM only with feat/canboard-do-pwm (0x2100 subs 2-10), never the fork's freq/ramp subs
const cbStock = { family: 'upstream', paramRuns: [[0x2100, 4, 0, 1]] }
const cbPwm = { family: 'upstream', paramRuns: [[0x2100, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }
assert.deepEqual(driveCaps(cbStock, true, 1), { pwm: false, varFreq: false, rampChanges: false })
assert.deepEqual(driveCaps(cbPwm, true, 4), { pwm: true, varFreq: false, rampChanges: false })
assert.deepEqual(driveCaps(fork, true, 1), { pwm: true, varFreq: true, rampChanges: true })
assert.deepEqual(driveCaps(up, false, 1), { pwm: false, varFreq: false, rampChanges: false })   // that list has subs 0-2 only

console.log('family.test.js ok')
