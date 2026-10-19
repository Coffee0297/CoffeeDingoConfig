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
console.log('canids.test.js ok')
