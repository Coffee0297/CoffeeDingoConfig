// node src/next/screens/functions/flow/delay.test.js — Compare on / off delay (upstream dingoFW feat/condition-delay,
// firmware functions/condition.cpp) in the flow builder simulator and the sentence view.
import assert from 'node:assert/strict'
import { buildModel } from './model.js'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const vmap = [{ index: 7, name: 'p State', kind: 'caninput', number: 1, prop: 'State', type: 'bool' }, { index: 8, name: 'p', kind: 'caninput', number: 1, prop: 'Value', type: 'float' },
  { index: 50, name: 'warn', kind: 'condition', number: 1, prop: 'Value', type: 'int' }]
const mk = (delayOn, delayOff) => buildModel({ type: 'dingoPDM', family: 'upstream', outputs: [] },
  { canInputs: [{ number: 1, name: 'p', enabled: true, id: 0x100, bitLength: 8 }], conditions: [{ number: 1, name: 'warn', enabled: true, input: 8, operator: 2, arg: 5, delayOn, delayOff }] }, vmap)
// seq of [value, ms to run]: the result after each
const run = (dOn, dOff, seq) => { const sim = createSim(mk(dOn, dOff), {}); return seq.map(([x, ms]) => { sim.setCan('caninput:1', x); for (let k = 0; k < ms; k += 50) sim.step(50); return !!sim.vals[50] }) }

// no delays: at once
assert.deepEqual(run(0, 0, [[9, 50], [1, 50]]), [true, false])
// on 1000 / off 500 (counted from the step before, like the firmware's nLastSame): off at 600 ms, on by 1050; on 250 ms after, off by 550
assert.deepEqual(run(1000, 500, [[9, 600], [9, 450], [1, 250], [1, 300]]), [false, true, true, false])
// a 400 ms pulse never turns it on; a true blip restarts the off delay
assert.deepEqual(run(1000, 0, [[9, 400], [1, 50], [9, 400], [1, 50]]), [false, false, false, false])
assert.deepEqual(run(0, 500, [[9, 50], [1, 300], [9, 50], [1, 300], [1, 200]]), [true, true, true, true, false])

const words = (d) => { const m = mk(...d); return sentenceFor(m, m.nodes.get('condition:1')).map((s) => s.t ?? s.label).join(' ') }
assert.match(words([2000, 0]), /for at least 2 s/)
assert.match(words([0, 30000]), /stays on 30 s after/)
assert.doesNotMatch(words([0, 0]), /at least|stays on/)
console.log('delay.test.js ok')
