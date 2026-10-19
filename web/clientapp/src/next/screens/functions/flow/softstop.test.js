// node src/next/screens/functions/flow/softstop.test.js — soft stop (upstream output sub 31) in the simulator and sentence
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, pwmEnabled: true, fixedDuty: 100, softStopTime: 2000, currentLimit: 30 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', title: 'Fan switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['output:7', { id: 'output:7', kind: 'output', title: 'Fan', enabled: true, row: out, outs: [{ prop: 'On', idx: 10 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }]]) }
const sim = createSim(model, {})
const st = () => sim.status['output:7'].text
const run = (ms) => { for (let k = 0; k < ms / 50; k++) sim.step(50) }

sim.set(5, true); run(100); assert.equal(st(), 'ON')
sim.set(5, false); run(100)
assert.equal(st(), 'STOPPING'); assert.equal(sim.vals[10], true)          // ramping down, still reports On
run(1950); assert.equal(st(), 'OFF')                                       // 2 s after the input went off
sim.set(5, true); run(100); sim.set(5, false); run(500)
sim.set(5, true); run(50); assert.equal(st(), 'ON')                         // back on mid-ramp
sim.set(5, false); run(100); sim.fault('output:7', 'oc'); sim.set(5, true); run(50); sim.set(5, false); run(50)
sim.fault('output:7', 'none'); run(50); assert.equal(st(), 'OFF')            // a trip cuts the soft stop
out.softStopTime = 0; sim.set(5, true); run(100); sim.set(5, false); run(50)
assert.equal(st(), 'OFF')                                                  // 0 = off at once
out.softStopTime = 2000; out.pwmEnabled = false; sim.set(5, true); run(100); sim.set(5, false); run(50)
assert.equal(st(), 'OFF')                                                  // not PWM: no soft stop

const txt = () => sentenceFor(model, nodes.get('output:7')).map((s) => s.t ?? s.label).join(' ')
assert.doesNotMatch(txt(), /ramps down/)
out.pwmEnabled = true
assert.match(txt(), /When it turns off, its duty ramps down over 2000 ms first\.$/)
console.log('softstop.test OK')
