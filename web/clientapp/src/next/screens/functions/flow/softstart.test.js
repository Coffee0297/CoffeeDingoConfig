// node src/next/screens/functions/flow/softstart.test.js — the output sentence of a current-limited soft start (sub 30)
import assert from 'node:assert/strict'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, pwmEnabled: true, fixedDuty: 100, softStart: true, softStartRamp: 2000, inrushLimit: 14, softStartTimeout: 5000 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', title: 'Fan switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['output:7', { id: 'output:7', kind: 'output', title: 'Fan', enabled: true, row: out, outs: [{ prop: 'On', idx: 10 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }]]) }
const txt = () => sentenceFor(model, nodes.get('output:7')).map((s) => s.t ?? s.label).join(' ')
assert.match(txt(), /\. Its soft start waits while the current is above 14 A and it trips if not at full duty after 5000 ms \.$/)
out.softStartTimeout = 0
assert.doesNotMatch(txt(), /waits/)
out.softStartTimeout = 5000; out.softStart = false
assert.doesNotMatch(txt(), /waits/)
console.log('softstart.test OK')
