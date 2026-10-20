// node src/next/screens/power/parts/ignition.test.js
import assert from 'node:assert/strict'
import { fixMain, mainCandidates, ignitionMain } from './ignition.js'

assert.equal(fixMain('ignition-main:abc-1'), 'abc-1')
assert.equal(fixMain(null), null)
assert.equal(fixMain('other'), null)

const pdm = { guid: 'p', type: 'dingoPDM', version: 'v5.7.0', family: 'upstream', ignition: { enabled: true, role: 'main' } }
const cb1 = { guid: 'c1', type: 'CANBoard', version: 'v5.7.0', family: 'upstream', paramRuns: [[0x1E00, 1, 0, 1, 2]] }
const cb2 = { guid: 'c2', type: 'CANBoard', version: 'v5.7.0', family: 'upstream', paramRuns: [[0x0000, 1, 0]] }   // a 5.7 build without the block
const cb0 = { guid: 'c0', type: 'CANBoard', version: 'v5.5.0', family: 'fork' }   // no ignition block
assert.equal(ignitionMain([pdm, cb1]), pdm)
assert.deepEqual(mainCandidates([pdm, cb1, cb0, cb2], pdm).map((d) => d.guid), ['c1'])
assert.deepEqual(mainCandidates([pdm, cb1], cb1), [])
assert.deepEqual(mainCandidates([pdm, { ...cb2, paramRuns: null }], pdm).length, 1)   // converted, not read yet
console.log('ignition ok')
