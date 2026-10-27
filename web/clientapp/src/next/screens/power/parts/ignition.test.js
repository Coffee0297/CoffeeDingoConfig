// node src/next/screens/power/parts/ignition.test.js
import assert from 'node:assert/strict'
import { fixMain, mainCandidates, ignitionMain, hasSync, resolveSync, statusWords, hasStatusId, resolveStatus } from './ignition.js'

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

// 5.7 sync id
const m = { guid: 'm', name: 'PDM-02', type: 'dingoPDM', baseId: 0x6A0, family: 'upstream', paramRuns: [[0x1E00, 1, 10, 11, 12]], ignition: { stateId: 0x6A0 + 36 } }
const f1 = { guid: 'f', name: 'PDM-03', type: 'dingoPDM', baseId: 0x6C0, family: 'upstream', txSpan: 36 }
assert.ok(hasSync(m)); assert.ok(!hasSync({ ...m, family: 'fork' })); assert.ok(!hasSync({ ...m, paramRuns: [[0x1E00, 1, 10]] }))
assert.deepEqual(resolveSync(m, 0, 0x6F1, [m, f1]), { id: 0x6F1, error: '', warn: '' })
assert.match(resolveSync(m, 0, 0x800).error, /0 to 0x7FF/)
assert.match(resolveSync(m, 1, 36).error, /own frames.*offset of 37/)   // base+36 = its own status frame
assert.equal(resolveSync(m, 1, 37, [m]).id, 0x6A0 + 37)
assert.match(resolveSync(m, 1, 0x200).error, /above 0x7FF/)
assert.match(resolveSync(m, 1, 0x30, [m, f1]).warn, /PDM-03/)   // 0x6D0 is inside PDM-03's 0x6C0..0x6E4
const cb = { guid: 'c', name: 'CB-1', type: 'CANBoard', baseId: 0x660 }
assert.match(resolveSync(cb, 1, 13).error, /own frames/)
assert.equal(resolveSync(cb, 1, 14).error, '')
assert.equal(ignitionMain([{ ...pdm, ignition: { enabled: true, role: 'standalone' } }]).guid, 'p')
assert.equal(statusWords({ dash: 2, sleep: 2, sleepInS: 90, link: 0 }), 'dash grace (dash still on) · sleep in 90 s')
assert.equal(statusWords({ dash: 1, sleep: 3, sleepInS: 0, link: 2 }), 'dash on · following the main · main lost')
// 5.7 status frame id (sub 23)
assert.ok(!hasStatusId(m)); assert.ok(hasStatusId({ ...m, paramRuns: [[0x1E00, 1, 23]] })); assert.ok(!hasStatusId({ ...m, family: 'fork' }))
assert.deepEqual(resolveStatus(m, 0x7A0, [m, f1], 0x6F1), { id: 0x7A0, error: '', warn: '' })
assert.equal(resolveStatus(m, 0x6A0 + 36, [m], 0x6F1).error, '')               // its own slot
assert.match(resolveStatus(m, 0x6A0 + 5, [m], 0x6F1).error, /own frames/)      // its own Msg 3
assert.match(resolveStatus(m, 0x6F1, [m], 0x6F1).error, /sync id/)
assert.equal(resolveStatus(m, 0x6F1, [m], null).error, '')                     // standalone: no sync frame
assert.match(resolveStatus(m, 0, [m]).error, /0x001 to 0x7FF/)
assert.match(resolveStatus(m, 0x800, [m]).error, /0x001 to 0x7FF/)
assert.match(resolveStatus(m, 0x6D0, [m, f1]).warn, /PDM-03/)                  // inside PDM-03's range
assert.match(resolveStatus(m, 0x7A0, [m, { ...f1, ignition: { statusId: 0x7A0 } }]).warn, /PDM-03/)   // PDM-03's status id
assert.match(resolveStatus(cb, 0x660 + 13, [cb]).error, /own frames/)          // CANBoard bootloader id
assert.equal(resolveStatus(cb, 0x660 + 12, [cb]).error, '')
console.log('ignition ok')
