// Self-check: `node setupsheet.test.js`.
import assert from 'node:assert/strict'
import { sheetRows, setupSheetHtml } from './setupsheet.js'

const defs = { pdms: [{ typeName: 'dingoPDM', outputCurrentRatings: [14, 14, 8, 8, 8, 8, 8, 8] }] }
const pdm = {
  name: 'Front <PDM>', type: 'dingoPDM', baseId: 0x680, version: '5.6.6',
  outputs: [
    { number: 1, name: 'Fuel pump', enabled: true, input: 'Ignition', currentLimit: 12, inrushLimit: 40, wireGaugeMm2: 0, wireLength: 3 },
    { number: 2, name: 'Fan', enabled: true, input: 'None', currentLimit: 20, inrushLimit: 50, wireGaugeMm2: 1.5, wireLength: 2, wireColor: 'red' },
    { number: 3, name: 'Spare', enabled: false, currentLimit: 5 },
  ],
}
const fx = {
  inputs: [{ number: 1, name: 'Ign sw', enabled: true, mode: 0, pull: 2 }, { number: 2, name: 'x', enabled: false }],
  canInputs: [{ number: 1, name: 'RPM', enabled: true, id: 0x360, ide: false, startBit: 0, bitLength: 16, byteOrder: 1, factor: 1, offset: 0 },
    { number: 2, name: 'Lost', enabled: true, id: 0x7a0, ide: false, startBit: 8, bitLength: 1, byteOrder: 0, factor: 1, offset: -40 }],
}
const claimed = { '360': ['ECU: ECU msg'] }
const r = sheetRows({ device: pdm, fx, defs, claimed })

// pins from pinmap, disabled outputs and inputs left out
assert.deepEqual(r.outputs.map((o) => [o.tag, o.pin]), [['OUT1', 'J3-7'], ['OUT2', 'J3-12']])
assert.deepEqual(r.digital.map((i) => [i.pin, i.how]), [['J3-8', 'momentary, pull-down']])
// no gauge chosen -> the recommendation for the limit, marked; chosen under the recommendation -> flagged
assert.equal(r.outputs[0].gauge, '1.5 mm² (16 AWG)'); assert.equal(r.outputs[0].recommended, true)
assert.equal(r.outputs[1].under, true); assert.equal(r.outputs[1].recommended, false)
assert.equal(r.outputs[0].rating, 14)
assert.ok(Math.abs(r.outputs[0].drop.volts - (2 * 3 * 12 * 0.0175) / 1.5) < 1e-9)
// CAN input source from the id map, else none
assert.equal(r.can[0].source, 'ECU: ECU msg'); assert.equal(r.can[1].source, ''); assert.equal(r.can[1].scale, '×1 − 40')
// harness: two 1.5 mm² output wires, J1/J2/J3 used, 5 m entered
assert.deepEqual(r.harness.gauges, [{ mm2: 1.5, awg: '16', count: 2 }])
assert.deepEqual(r.harness.connectors, ['J1', 'J2', 'J3'])
assert.equal(r.harness.lengthM, 5); assert.equal(r.harness.signalWires, 1)

// escaping
const html = setupSheetHtml({ device: pdm, fx, defs, claimed })
assert.ok(html.includes('Front &lt;PDM&gt; setup sheet')); assert.ok(!html.includes('<PDM>'))
assert.ok(html.includes('not in the project'))

// CANBoard: outputs from /functions with names from the var map, analog pins
const cb = { name: 'CB', type: 'CANBoard', baseId: 0x660 }
const c = sheetRows({ device: cb, fx: { digitalOut: [{ number: 1, name: 'Horn', enabled: true, input: 7 }], digitalIn: [], analogIn: [{ number: 4, name: 'Rot', enabled: true }] }, names: { 7: 'Horn btn' } })
assert.deepEqual([c.outputs[0].tag, c.outputs[0].pin, c.outputs[0].driven, c.outputs[0].gauge], ['DO1', 'J4-2', 'Horn btn', ''])
assert.equal(c.analog[0].pin, 'J2-6')
console.log('setupsheet ok')
