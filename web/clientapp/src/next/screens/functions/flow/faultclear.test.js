// node src/next/screens/functions/flow/faultclear.test.js — the simulator's latched trip and the upstream fault clear
// (output clear on re-assert, module retry-all edge at most every 2 s), plus their sentences.
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, resetMode: 0, currentLimit: 10, clearOnReassert: false }
const nodes = new Map([
  ['sys', { id: 'sys', kind: 'sys', title: 'PDM-01', enabled: true, row: { retryAllInput: 6 }, outs: [] }],
  ['input:1', { id: 'input:1', kind: 'input', title: 'Pump switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['input:2', { id: 'input:2', kind: 'input', title: 'Reset button', enabled: true, outs: [{ prop: 'State', idx: 6, label: 'State' }] }],
  ['output:1', { id: 'output:1', kind: 'output', title: 'Pump', enabled: true, row: out,
    outs: [{ prop: 'On', idx: 10 }, { prop: 'Overcurrent', idx: 11 }, { prop: 'Fault', idx: 12 }, { prop: 'Current', idx: 13 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }], [6, { kind: 'input', number: 2 }]]) }
const sim = createSim(model, {})
const st = () => sim.status['output:1'].text
const run = (ms) => { for (let k = 0; k < ms / 50; k++) sim.step(50) }

sim.set(5, true); run(100)
assert.equal(st(), 'ON')
sim.fault('output:1', 'oc'); run(100)
assert.equal(st(), 'FAULT')                                   // reset mode None: latched at once
sim.fault('output:1', 'none'); run(100)
assert.equal(st(), 'FAULT'); assert.equal(sim.vals[10], false); assert.equal(sim.vals[12], true)
sim.set(5, false); run(100); sim.set(5, true); run(100)
assert.equal(st(), 'FAULT')                                   // no clear on re-assert: switching does nothing
assert.match(sim.status['output:1'].why, /retry-all signal turns on or the module is power-cycled/)

run(2000)
sim.set(6, true); run(100)
assert.equal(st(), 'ON')                                      // retry-all edge
sim.set(6, false); sim.fault('output:1', 'oc'); run(100); sim.fault('output:1', 'none'); run(100)
assert.equal(st(), 'FAULT')
sim.set(6, true); run(100)
assert.equal(st(), 'FAULT')                                   // second edge inside 2 s: ignored
sim.set(6, false); run(2000); sim.set(6, true); run(100)
assert.equal(st(), 'ON')                                      // 2 s later: cleared
sim.set(6, false)

out.clearOnReassert = true
sim.fault('output:1', 'oc'); run(100); sim.fault('output:1', 'none'); run(100)
assert.equal(st(), 'FAULT')
sim.set(5, false); run(100)
assert.equal(st(), 'OFF')
sim.set(5, true); run(100)
assert.equal(st(), 'ON')                                      // cleared by switching off and on

// reset mode Count: TRIPPED while retries remain, FAULT once they have run out
Object.assign(out, { resetMode: 1, resetTime: 500, resetCountLimit: 2 })
sim.fault('output:1', 'oc'); run(500)
assert.equal(st(), 'TRIPPED')
run(600)
assert.equal(st(), 'FAULT')
sim.fault('output:1', 'none')

// sentences
const txt = (n) => sentenceFor(model, n)?.map((s) => s.t ?? s.label).join(' ')
assert.match(txt(nodes.get('sys')), /^Each time Reset button turns on, every tripped output on PDM-01 tries again \(at most once every 2 s\)\.$/)
assert.match(txt(nodes.get('output:1')), /switching it on again retries/)
nodes.get('sys').row.retryAllInput = 0
assert.equal(sentenceFor(model, nodes.get('sys')), null)
console.log('faultclear.test OK')
