// node src/next/screens/functions/flow/hyst.test.js — Compare hysteresis: the fork's release point vs upstream
// dingoFW's band (feat/condition-hysteresis, firmware functions/condition.cpp), in the flow builder simulator.
import assert from 'node:assert/strict'
import { buildModel, hystBand } from './model.js'
import { createSim } from './sim.js'

assert.equal(hystBand(2, 95, 90), 5)    // > 95, off at 90: band 5
assert.equal(hystBand(4, 95, 90), 5)
assert.equal(hystBand(3, 10, 12), 2)    // < 10, off at 12
assert.equal(hystBand(2, 95, 99), 0)    // release point on the wrong side: no band
assert.equal(hystBand(2, 95, undefined), 0)
assert.equal(hystBand(0, 95, 90), 0)    // == has none

const vmap = [{ index: 7, name: 'temp State', kind: 'caninput', number: 1, prop: 'State', type: 'bool' }, { index: 8, name: 'temp', kind: 'caninput', number: 1, prop: 'Value', type: 'float' },
  { index: 50, name: 'fan', kind: 'condition', number: 1, prop: 'Value', type: 'int' }]
const run = (family, argOff, seq) => {
  const funcs = { canInputs: [{ number: 1, name: 'temp', enabled: true, id: 0x100, bitLength: 8 }], conditions: [{ number: 1, name: 'fan', enabled: true, input: 8, operator: 2, arg: 95, argOff }] }
  const sim = createSim(buildModel({ type: 'dingoPDM', family, outputs: [] }, funcs, vmap), {})
  return seq.map((x) => { sim.setCan('caninput:1', x); sim.step(50); return !!sim.vals[50] })
}
// > 95, off again at 90: the same on both families
const seq = [94, 96, 92, 91, 90, 93, 96]   // firmware: 91 still on, 90 off (the same operator against 95 − 5)
assert.deepEqual(run('fork', 90, seq), [false, true, true, true, false, false, true])
assert.deepEqual(run('upstream', 90, seq), [false, true, true, true, false, false, true])
// off point above the on point: the fork turns on at 99 and off at 95; upstream has no band, a plain > 95
assert.deepEqual(run('fork', 99, [97, 100, 97, 94]), [false, true, true, false])
assert.deepEqual(run('upstream', 99, [97, 100, 97, 94]), [true, true, true, false])
console.log('hyst.test.js ok')
