// node src/next/screens/functions/flow/undercurrent.test.js — the simulator's undercurrent (upstream output subs 27-29):
// report mode sets the Undercurrent signal after the time, trip mode latches Fault; and the sentences.
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, currentLimit: 20, underLimit: 6, underTime: 1500, underTrip: false }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', enabled: true, outs: [{ prop: 'State', idx: 5 }] }],
  ['output:1', { id: 'output:1', kind: 'output', enabled: true, row: out,
    outs: [{ prop: 'On', idx: 10 }, { prop: 'Fault', idx: 12 }, { prop: 'Current', idx: 13 }, { prop: 'Undercurrent', idx: 241 }] }],
])
const model = { nodes, byIdx: new Map() }
const sim = createSim(model, { 13: 8.2 })
const st = () => sim.status['output:1'].text
const run = (ms) => { for (let k = 0; k < ms / 50; k++) sim.step(50) }
sim.set(5, true); run(100)
assert.equal(st(), 'ON')
sim.fault('output:1', 'under'); run(1000)
assert.equal(st(), 'ON'); assert.equal(sim.vals[241], false)       // not 1.5 s yet
run(600)
assert.equal(st(), 'UNDERCURRENT'); assert.equal(sim.vals[241], true); assert.equal(sim.vals[10], true)   // report only
sim.fault('output:1', 'none'); run(50)
assert.equal(st(), 'ON'); assert.equal(sim.vals[241], false)
out.underTrip = true
sim.fault('output:1', 'under'); run(1600)
assert.equal(st(), 'TRIPPED'); assert.deepEqual([sim.vals[10], sim.vals[12], sim.vals[241]], [false, true, false])
sim.fault('output:1', 'none'); run(200)
assert.equal(st(), 'TRIPPED')                                        // latched like the firmware
const off = { ...out, underLimit: 0 }
const sim2 = createSim({ nodes: new Map([...nodes, ['output:1', { ...nodes.get('output:1'), row: off }]]), byIdx: new Map() }, {})
sim2.set(5, true); sim2.fault('output:1', 'under'); for (let k = 0; k < 60; k++) sim2.step(50)
assert.equal(sim2.status['output:1'].text, 'ON')                     // limit 0 = off

const txt = () => sentenceFor(model, nodes.get('output:1'))?.map((s) => s.t ?? s.label).join(' ')
assert.match(txt(), /It switches off and latches a fault below 6 A for 1500 ms \.$/)
out.underTrip = false
assert.match(txt(), /It reports too little current below 6 A for 1500 ms \.$/)
out.underLimit = 0
assert.doesNotMatch(txt(), /too little|latches/)
console.log('undercurrent.test OK')
