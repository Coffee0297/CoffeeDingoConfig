// Self-check: `node dbcexport.test.js`. A module's own CAN outputs and CAN messages land in the combined DBC.
import assert from 'node:assert/strict'
import { buildDbc, moduleTxFrames } from './dbcexport.js'

const funcs = {
  canOutputs: [
    { name: 'Screen: Left turn indicator', enabled: true, id: 0x7b0, ide: false, startBit: 1, bitLength: 1, factor: 1, offset: 0, byteOrder: 0, signed: false, kind: 0 },
    { name: 'Screen: Right turn indicator', enabled: true, id: 0x7b0, ide: false, startBit: 2, bitLength: 1, factor: 1, offset: 0, byteOrder: 0, signed: false, kind: 0 },
    { name: 'Coolant x10', enabled: true, id: 0x18ff0001, ide: true, startBit: 8, bitLength: 16, factor: 0.1, offset: -40, byteOrder: 0, signed: true, kind: 0 },
    { name: 'Alive', enabled: true, id: 0x7b1, ide: false, startBit: 60, bitLength: 4, factor: 5, offset: 3, byteOrder: 0, signed: true, kind: 1 },
    { name: 'off', enabled: false, id: 0x123, startBit: 0, bitLength: 8 },
  ],
  canMessages: [
    { name: 'Dash shutdown', enabled: true, id: 0x5ab, ide: false, dlc: 3, data: [1, 2, 3], checksum: 2, checksumByte: 2, counterByte: 0 },
    { name: 'Plain', enabled: true, id: 0x5ac, ide: false, dlc: 8, checksum: 0, checksumByte: 7, counterByte: 0xff },
  ],
}
const dbc = buildDbc(moduleTxFrames('CB-1', funcs))

// two outputs on one id share one message; its length is what the firmware sends (bit 2 -> 1 byte)
assert.match(dbc, /BO_ 1968 CB_1_7B0: 1 CB_1\n SG_ Screen__Left_turn_indicator : 1\|1@1\+ \(1,0\)/)
assert.match(dbc, /SG_ Screen__Right_turn_indicator : 2\|1@1\+/)
assert.equal((dbc.match(/BO_ 1968 /g) ?? []).length, 1)
// extended id, scaling as sent (raw = (value - offset) / factor), signed, 16 bits -> 3 bytes
assert.match(dbc, new RegExp(`BO_ ${(0x18ff0001 | 0x80000000) >>> 0} CB_1_18FF0001: 3 CB_1\\n SG_ Coolant_x10 : 8\\|16@1- \\(0\\.1,-40\\)`))
// a rolling counter is raw: no scaling, unsigned
assert.match(dbc, /BO_ 1969 CB_1_7B1: 8 CB_1\n SG_ Alive : 60\|4@1\+ \(1,0\)/)
assert.ok(!/ off /.test(dbc) && !/BO_ 291 /.test(dbc), 'disabled output left out')
// a CAN message block: its own length, counter nibble and checksum byte
assert.match(dbc, /BO_ 1451 Dash_shutdown: 3 CB_1\n SG_ Dash_shutdown_counter : 0\|4@1\+ \(1,0\) \[0\|0\] "" Vector__XXX\n SG_ Dash_shutdown_checksum : 16\|8@1\+/)
// fixed bytes with nothing to decode: the message is still declared
assert.match(dbc, /BO_ 1452 Plain: 8 CB_1\n\n/)

console.log('dbcexport.test.js: all assertions passed')
