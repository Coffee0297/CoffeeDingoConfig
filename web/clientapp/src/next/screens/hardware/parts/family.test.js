// node src/next/screens/hardware/parts/family.test.js — upstream dingoFW gating helpers
import assert from 'node:assert/strict'
import { has, hasBlock, lacks, olderThan, isUpstream, ownLine, pwmFreqError, upstreamHas, driveCaps } from './util.js'
import { spanAfter } from '../../../../lib/canids.js'

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

assert.equal(upstreamHas(up, 0x1007, 2), true)
assert.equal(upstreamHas(up, 0x1007, 18), false)
assert.equal(upstreamHas(fork, 0x1000, 0), false)       // never on the fork
assert.equal(upstreamHas(upUnread, 0x1000, 0), false)   // not before the Read

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

// an upstream PDM with lookup tables (0x1B00) also sends Msg 30 at +32
assert.equal(spanAfter('dingoPDM', up), 30)
assert.equal(spanAfter('dingoPDM', { ...up, paramRuns: [...up.paramRuns, [0x1b00, 2, 0, 1]] }), 32)
assert.equal(spanAfter('dingoPDM', { ...up, paramRuns: [...up.paramRuns, [0x1b00, 4, 0, 1]] }), 33)   // more-tables: Msg 31
assert.equal(spanAfter('dingoPDM', fork), 30)
// the backend's span (TxSpan: 5.7 frames only while their feature is on) wins over the param-list guess
assert.equal(spanAfter('dingoPDM', { ...up, paramRuns: [...up.paramRuns, [0x1b00, 4, 0, 1]], txSpan: 31 }), 31)
assert.equal(spanAfter('CANBoard'), 14)

// drive card: CANBoard DO PWM only with feat/canboard-do-pwm (0x2100 subs 2-10), never the fork's freq/ramp subs
const cbStock = { family: 'upstream', paramRuns: [[0x2100, 4, 0, 1]] }
const cbPwm = { family: 'upstream', paramRuns: [[0x2100, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }
assert.deepEqual(driveCaps(cbStock, true, 1), { pwm: false, varFreq: false, rampChanges: false })
assert.deepEqual(driveCaps(cbPwm, true, 4), { pwm: true, varFreq: false, rampChanges: false })
assert.deepEqual(driveCaps(fork, true, 1), { pwm: true, varFreq: true, rampChanges: true })
assert.deepEqual(driveCaps(up, false, 1), { pwm: false, varFreq: false, rampChanges: false })   // that list has subs 0-2 only

console.log('family.test.js ok')

// the 5.7 line: upstream layout with the fork's own features (trip log)
assert.equal(ownLine({ family: 'upstream', version: 'v5.7.0' }), true)
assert.equal(ownLine({ family: 'upstream', version: 'v0.6.3' }), false)
assert.equal(ownLine({ family: 'fork', version: 'v5.6.6' }), false)
