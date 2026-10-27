// node src/next/screens/functions/flow/warnopen.test.js — the simulator's Warning / Open load report and the sentences
// (output subs 18-20: warning limit, open-load limit and time; report only).
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, currentLimit: 20, warnLimit: 0, openLoadLimit: 0, openLoadTime: 1000 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', title: 'Lamp switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['output:1', { id: 'output:1', kind: 'output', title: 'Lamp', enabled: true, row: out,
    outs: [{ prop: 'On', idx: 10 }, { prop: 'Overcurrent', idx: 11 }, { prop: 'Fault', idx: 12 }, { prop: 'Current', idx: 13 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }]]) }
const sim = createSim(model, { 13: 7.5 })   // the load drew 7.5 A live
const st = () => sim.status['output:1'].text
const run = (ms) => { for (let k = 0; k < ms / 50; k++) sim.step(50) }

sim.set(5, true); run(100)
assert.equal(st(), 'ON')
out.warnLimit = 5; run(50)
assert.equal(st(), 'WARNING')                     // 7.5 A above the 5 A warning: still on
assert.equal(sim.vals[10], true)
out.warnLimit = 10; run(50)
assert.equal(st(), 'ON')

sim.fault('output:1', 'open'); run(2000)
assert.equal(st(), 'ON')                          // no open-load limit: the module reports it as on
sim.fault('output:1', 'none'); run(50)
out.openLoadLimit = 1
sim.fault('output:1', 'open'); run(900)
assert.equal(st(), 'ON')                          // not yet missing for 1000 ms
run(200)
assert.equal(st(), 'OPEN LOAD')
assert.equal(sim.vals[10], true)                  // report only: the output stays on
sim.fault('output:1', 'none'); run(50)
assert.equal(st(), 'ON')
sim.fault('output:1', 'open'); run(500)
assert.equal(st(), 'ON')                          // the time restarts after the load came back

const txt = (n) => sentenceFor(model, n)?.map((s) => s.t ?? s.label).join(' ')
assert.match(txt(nodes.get('output:1')), /It reports a warning above 10 A \. It reports a missing load below 1 A for 1000 ms \.$/)
out.warnLimit = 0; out.openLoadLimit = 0
assert.doesNotMatch(txt(nodes.get('output:1')), /reports/)
console.log('warnopen.test OK')
