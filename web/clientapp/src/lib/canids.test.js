// node src/lib/canids.test.js — module CAN-id footprints, incl. an upstream main's ignition state frame (base + 32)
import assert from 'node:assert/strict'
import { spanAfter, conflictPairs } from './canids.js'

const pdm = (baseId, ignition) => ({ guid: String(baseId), type: 'dingoPDM', baseId, ignition })
assert.equal(spanAfter('dingoPDM'), 30)
assert.equal(spanAfter('CANBoard'), 14)
assert.equal(spanAfter('dingoPDM', pdm(0x680, { enabled: true, role: 'main', stateId: 0x680 + 30 })), 30)   // fork main
assert.equal(spanAfter('dingoPDM', pdm(0x680, { enabled: true, role: 'main', stateId: 0x680 + 32 })), 32)   // upstream main
assert.equal(spanAfter('dingoPDM', pdm(0x680, { enabled: true, role: 'follower', stateId: 0x680 + 32 })), 30) // a follower sends none
assert.equal(spanAfter('dingoPDM', pdm(0x680, { enabled: false, role: 'main', stateId: 0x680 + 32 })), 30)
// an upstream main at 0x680 sends its state on 0x6A0: the base of a PDM 0x20 above clashes, 0x30 above does not
assert.equal(conflictPairs([pdm(0x680, { enabled: true, role: 'main', stateId: 0x6a0 }), pdm(0x6a0)]).length, 1)
assert.equal(conflictPairs([pdm(0x680, { enabled: true, role: 'main', stateId: 0x6a0 }), pdm(0x6b0)]).length, 0)
assert.equal(conflictPairs([pdm(0x680, { enabled: true, role: 'main', stateId: 0x69e }), pdm(0x6a0)]).length, 0)
// 5.7: a PDM sends up to +31 (txSpan from the backend), filling its 0x20 slot: the next PDM shares no id, no clash
assert.equal(conflictPairs([{ ...pdm(0x680), txSpan: 31 }, { ...pdm(0x6a0), txSpan: 31 }]).length, 0)
assert.equal(conflictPairs([{ ...pdm(0x680), txSpan: 34 }, { ...pdm(0x6a0), txSpan: 31 }]).length, 1)
// integration/all-features: wire load, tables 1-4, PID = +32..+35, an enabled main's ignition state + 36
const all = { family: 'upstream', baseId: 0x680, paramRuns: [[0x1000, 8, ...Array.from({ length: 35 }, (_, k) => k)], [0x1b00, 4, 0, 1], [0x2300, 4, 0, 1]] }
assert.equal(spanAfter('dingoPDM', all), 35)
assert.equal(spanAfter('dingoPDM', { ...all, ignition: { enabled: true, role: 'main', stateId: 0x680 + 36 } }), 36)
assert.equal(spanAfter('dingoPDM', { ...all, paramRuns: [[0x2300, 4, 0, 1]] }), 32)   // the PID alone: Msg 30
assert.equal(spanAfter('dingoPDM', { ...all, family: 'fork' }), 30)
console.log('canids.test.js ok')
