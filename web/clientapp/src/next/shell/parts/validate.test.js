// node src/next/shell/parts/validate.test.js
import assert from 'node:assert/strict'
import { checkModule, checkCanMap, lastByte } from './validate.js'

const dev = {
  guid: 'g1', name: 'PDM-01', type: 'dingoPDM',
  outputs: [
    { number: 1, name: 'Fan', enabled: true, inputVal: 10, currentLimit: 20, inrushLimit: 30, inrushTime: 500 },
    { number: 2, name: 'Lamp', enabled: true, inputVal: 11, currentLimit: 8, inrushLimit: 5, inrushTime: 200 },
    { number: 3, name: '', enabled: false, inputVal: 0, currentLimit: 50 },
  ],
}
const funcs = {
  device: {},
  inputs: [{ number: 1, enabled: true }],
  conditions: [
    { number: 1, enabled: true, input: 1 },     // feeds output 2
    { number: 2, enabled: true, input: 0 },     // no input, nothing reads it
    { number: 3, enabled: true, input: 99 },    // reads a var that does not exist
  ],
  timers: [{ number: 1, enabled: false, input: 1 }],   // switched off but output 1 reads it
  flashers: [{ number: 1, enabled: true, input: 1, onTime: 0, offTime: 500 }],
  canOutputs: [{ number: 1, enabled: true, input: 1, id: 0, interval: 100 }],
  canInputs: [
    { number: 1, enabled: true, id: 0x123, startBit: 60, bitLength: 8, byteOrder: 0 },
    { number: 2, enabled: true, id: 0x690, startBit: 0, bitLength: 8, byteOrder: 0 },
  ],
}
const vmap = [
  { index: 1, kind: 'input', number: 1, prop: 'State', type: 'bool', name: 'DI1' },
  { index: 10, kind: 'timer', number: 1, prop: 'Value', type: 'bool', name: 'T1' },
  { index: 11, kind: 'condition', number: 1, prop: 'Value', type: 'bool', name: 'C1' },
  { index: 12, kind: 'condition', number: 2, prop: 'Value', type: 'bool', name: 'C2' },
  { index: 13, kind: 'condition', number: 3, prop: 'Value', type: 'bool', name: 'C3' },
  { index: 14, kind: 'flasher', number: 1, prop: 'Value', type: 'bool', name: 'F1' },
  { index: 20, kind: 'caninput', number: 1, prop: 'State', type: 'bool', name: 'CI1' },
  { index: 21, kind: 'caninput', number: 2, prop: 'State', type: 'bool', name: 'CI2' },
]
const def = { outputCurrentRatings: [14, 14, 8] }
const claimed = { '690': ['CB-1: broadcast'] }

const r = checkModule({ dev, funcs, vmap, def, claimed })
const has = (level, node, re) => r.some((i) => i.level === level && i.node === node && re.test(i.why))

assert.ok(has('error', 'output:1', /more than the 14 A/), 'limit above the pin rating is an error')
assert.ok(!r.some((i) => i.node === 'output:2' && /rated/.test(i.why)), 'limit within the rating is fine')
assert.ok(!r.some((i) => i.node === 'output:3'), 'a switched-off output is not checked')
assert.ok(has('warn', 'output:2', /trips at less during the first 200 ms/), 'inrush below the trip current')
assert.ok(has('warn', 'condition:2', /needs an input/), 'unbound input is a warning')
assert.ok(has('warn', 'condition:2', /nothing on this module uses it/), 'unused enabled block')
assert.ok(has('error', 'condition:3', /does not have \(#99\)/), 'missing source is an error')
assert.ok(has('warn', 'timer:1', /switched off/), 'disabled source is a warning')
assert.ok(has('error', 'flasher:1', /must be above 0/), 'out-of-range value is an error')
assert.ok(has('error', 'canoutput:1', /0x000/), 'a CAN output with no id would send on 0x000')
assert.ok(has('error', 'caninput:1', /past the 8 data bytes/), 'signal outside the frame')
assert.ok(has('warn', 'caninput:1', /no module or ECU/), 'id nothing in the project sends')
assert.ok(!r.some((i) => i.node === 'caninput:2' && /no module or ECU/.test(i.why)), 'claimed id is fine')
assert.ok(r.every((i) => i.guid === 'g1' && i.module === 'PDM-01'))

// a CANBoard has no current-rated outputs to check
assert.equal(checkModule({ dev: { guid: 'c', name: 'CB', type: 'CANBoard', outputs: [{ number: 1, enabled: true, currentLimit: 99 }] }, funcs: {}, vmap: [], def: { outputCurrentRatings: [1] }, claimed: null }).length, 0)

// bus-wide
const devices = [{ guid: 'g1', name: 'PDM-01' }, { guid: 'g2', name: 'CB-1' }]
const m = checkCanMap({
  collisions: [{ hex: '0x300', owners: ['PDM-01: CAN out \'x\'', 'CB-1: broadcast'] }],
  overlaps: [{ a: 'PDM-01', b: 'CB-1', aRange: '0x680–0x69D', bRange: '0x690–0x69D' }],
}, devices)
assert.equal(m.filter((i) => /0x300/.test(i.title)).length, 2, 'a collision is reported on both modules')
assert.equal(m.filter((i) => /overlap/.test(i.why)).length, 2)
assert.ok(m.every((i) => i.level === 'error'))

assert.equal(lastByte(56, 8, 0), 7); assert.equal(lastByte(57, 8, 0), 8)
assert.equal(lastByte(7, 16, 1), 1); assert.equal(lastByte(63, 8, 1), 7)

console.log('validate.test.js ok')
