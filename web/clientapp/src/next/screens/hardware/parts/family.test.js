// node src/next/screens/hardware/parts/family.test.js — upstream dingoFW gating helpers
import assert from 'node:assert/strict'
import { has, hasBlock, lacks, olderThan, isUpstream, pwmFreqError } from './util.js'

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

// output PWM frequency: upstream 16-400 Hz or 0 (keep), fork 15-400 Hz (fix/pwm-low-freq)
assert.deepEqual([0, 10, 15, 16, 400, 401].map((hz) => !pwmFreqError(up, hz)), [true, false, false, true, true, false])
assert.deepEqual([0, 15, 400].map((hz) => !pwmFreqError(fork, hz)), [false, true, true])

console.log('family.test.js ok')
