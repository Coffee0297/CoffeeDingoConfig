// node src/next/screens/power/parts/sleepParams.test.js — per-family sleep param writes
import assert from 'node:assert/strict'
import { SUB, upstreamWrite, upSub } from './sleepParams.js'

const fork = { family: 'fork', version: 'v5.6.6' }
const up = { family: 'upstream', version: 'v0.6.1', paramRuns: [[0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8]] }
const upCfg = { family: 'upstream', version: 'v0.6.1', paramRuns: [[0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]] }
const upUnread = { family: 'upstream', version: 'v0.6.1', paramRuns: null }

assert.deepEqual(upstreamWrite(fork, SUB.wakeMask, 2), [[12, 2]])
assert.deepEqual(upstreamWrite(fork, SUB.timeout, 5000), [[5, 5000]])
// plain upstream: no timeout / ignore-always-on, the mask collapses to all/none
assert.deepEqual(upstreamWrite(up, SUB.timeout, 5000), [])
assert.deepEqual(upstreamWrite(up, SUB.ignoreAlwaysOn, 1), [])
assert.deepEqual(upstreamWrite(up, SUB.wakeMask, 2), [[4, 0]])
assert.deepEqual(upstreamWrite(up, SUB.wakeMask, 0), [[4, 1]])
assert.deepEqual(upstreamWrite(up, SUB.wakeCan, 0), [[5, 1]])
// feat/sleep-config: subs 9-11
assert.deepEqual(upstreamWrite(upCfg, SUB.timeout, 5000), [[9, 5000]])
assert.deepEqual(upstreamWrite(upCfg, SUB.ignoreAlwaysOn, 1), [[10, 1]])
assert.deepEqual(upstreamWrite(upCfg, SUB.wakeMask, 2), [[4, 0], [11, 2]])
assert.deepEqual(upstreamWrite(upCfg, SUB.wakeMask, 0), [[4, 1]])
// before a Read the module's list is unknown: never write a sub it may not have
assert.equal(upSub(upUnread, 9), false)
assert.deepEqual(upstreamWrite(upUnread, SUB.timeout, 5000), [])
assert.equal(upSub(fork, 9), false)

console.log('sleepParams.test.js ok')
