// node src/next/screens/functions/flow/hardshort.test.js — hard short limit (upstream output sub 32): sentence and the
// simulator's trip explanation
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, currentLimit: 12, resetMode: 2, resetTime: 1000, hardShortLimit: 40 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', title: 'Light switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['output:2', { id: 'output:2', kind: 'output', title: 'Headlight', enabled: true, row: out, outs: [{ prop: 'On', idx: 10 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }]]) }
const txt = () => sentenceFor(model, nodes.get('output:2')).map((s) => s.t ?? s.label).join(' ')
assert.match(txt(), /\. Above 40 A \(a dead short\) it latches off at once, without retrying\.$/)
const sim = createSim(model, {})
sim.set(5, true); sim.fault('output:2', 'oc'); sim.step(50)
assert.equal(sim.status['output:2'].text, 'TRIPPED')
assert.match(sim.status['output:2'].why, /dead short \(above 40 A\) it latches off at once/)
out.hardShortLimit = 0; sim.step(50)
assert.doesNotMatch(sim.status['output:2'].why, /dead short/)
assert.doesNotMatch(txt(), /dead short/)
console.log('hardshort.test OK')
