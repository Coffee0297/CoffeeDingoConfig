// Self-check: `node businputs.test.js`.
import assert from 'node:assert/strict'
import { busInputOptions, physInput } from './businputs.js'
import { ioTag } from './pinmap.js'

const pdm = { guid: 'p', name: 'PDM-01', type: 'dingoPDM' }
const cb = { guid: 'c', name: 'CB-1', type: 'CANBoard' }
const local = [
  { index: 5, name: 'Condition 1', kind: 'condition', number: 1 },
  { index: 2, name: 'Horn button', kind: 'input', number: 2 },
]
const remotes = [{ device: cb, sigs: [
  { name: 'DigitalInput3.State', label: 'Ignition', kind: 'bool' },
  { name: 'AnalogInput1.Millivolts', label: 'Headlights · Millivolts', kind: 'value' },
  { name: 'Table1.Value', label: 'Fan duty', kind: 'value', isFloat: true },
] }]

const b = busInputOptions(pdm, local, remotes, 'bool')
assert.deepEqual(b.map((o) => o.value), [2, 5, 'remote:c:DigitalInput3.State'])    // own pin, own logic, then remote
assert.equal(b[0].label, 'PDM-01 · J3-11 DI2 · Horn button')
assert.equal(b[2].label, 'CB-1 · J3-3 DI3 · Ignition  (over CAN)')
assert.equal(b[2].pin.label, 'J3-3')
assert.ok(b[2].search.includes('pin 3'))

const n = busInputOptions(pdm, [], remotes, 'num')
assert.deepEqual(n.map((o) => o.value), ['remote:c:AnalogInput1.Millivolts'])          // bools and float32 left out
assert.equal(n[0].label, 'CB-1 · J2-2 AI1 · Headlights · Millivolts  (over CAN)')

// unused physical pins are offered (flagged, with the input to enable); unused logic is not
const u = busInputOptions(pdm, [], [{ device: cb, sigs: [
  { name: 'DigitalInput5.State', label: null, kind: 'bool', inUse: false },
  { name: 'VirtualInput2', label: null, kind: 'bool', inUse: false }] }], 'bool')
assert.equal(u.length, 1)
assert.equal(u[0].label, 'CB-1 · J3-5 DI5 · DigitalInput5.State · not enabled yet  (over CAN)')
assert.deepEqual(u[0].phys, { kind: 'input', number: 5 }); assert.ok(u[0].unused)
assert.deepEqual(physInput('Input2.State'), { kind: 'input', number: 2 })
assert.deepEqual(physInput('AnalogInput3.Millivolts'), { kind: 'analoginput', number: 3 })
assert.equal(physInput('RotarySwitch1.Pos'), null)
assert.deepEqual(b[0].phys, { kind: 'input', number: 2 })

assert.equal(ioTag(cb, 'digitaloutput', 2), 'DO2')
assert.equal(ioTag(pdm, 'output', 2), 'OUT2')
console.log('businputs ok')
