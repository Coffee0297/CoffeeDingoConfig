// node src/next/screens/functions/flow/timeoutvalue.test.js — a CAN input that times out, in the flow builder simulator
// and sentence: upstream dingoFW (feat/can-input-timeout-value) takes the timeout value only with timeoutUseValue
// (sub 15), else 0 and off; the result is the input's own test on that value (firmware functions/can_input.cpp).
import assert from 'node:assert/strict'
import { buildModel } from './model.js'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const vmap = [{ index: 7, name: 'coolant', kind: 'caninput', number: 1, prop: 'State', type: 'bool' }, { index: 8, name: 'coolant Value', kind: 'caninput', number: 1, prop: 'Value', type: 'float' }]
const after = (family, use) => {
  const row = { number: 1, name: 'coolant', enabled: true, id: 0x100, bitLength: 8, operator: 2, operand: 100, timeoutEnabled: true, timeout: 500, timeoutValue: 120, timeoutUseValue: use }
  const model = buildModel({ type: 'dingoPDM', family, outputs: [] }, { canInputs: [row] }, vmap)
  const sim = createSim(model, {})
  sim.setCan('caninput:1', 90); sim.step(50)
  assert.deepEqual([sim.vals[8], sim.vals[7]], [90, false])
  sim.fault('caninput:1', 'timeout'); sim.step(50)
  return [sim.vals[8], sim.vals[7], sentenceFor(model, model.nodes.get('caninput:1')).map((x) => x.t ?? x.label ?? '').join(' ')]
}
const [v1, s1, t1] = after('upstream', true)
assert.deepEqual([v1, s1], [120, true])                 // 120 > 100: the fan rule turns on
assert.match(t1, /reads 120/)
const [v0, s0, t0] = after('upstream', false)
assert.deepEqual([v0, s0], [0, false])                  // flag off: upstream's 0 and off
assert.match(t0, /reads 0, off/)
const [vf, sf, tf] = after('fork', false)               // fork: no flag, the simulator as before
assert.deepEqual([vf, sf], [0, false])
assert.match(tf, /reads 120/)
console.log('timeoutvalue.test.js ok')
