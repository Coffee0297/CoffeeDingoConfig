// node src/next/screens/functions/flow/trigger.test.js — CAN output trigger (upstream dingoFW feat/can-output-trigger,
// 0x2000+i sub 12): the Trigger port only where the module has it, one frame = one schedule, sentence wording.
import assert from 'node:assert/strict'
import { buildModel, framePeers } from './model.js'
import { sentenceFor } from './sentence.js'

const vmap = [{ index: 10, name: 'btn', kind: 'caninput', number: 2, prop: 'State', type: 'bool' }, { index: 8, name: 'v', kind: 'caninput', number: 1, prop: 'Value', type: 'float' }]
const funcs = (t2) => ({
  canInputs: [{ number: 1, name: 'v', enabled: true, id: 0x100, bitLength: 8 }, { number: 2, name: 'btn', enabled: true, id: 0x101, bitLength: 8 }],
  canOutputs: [{ number: 1, name: 'cmd', enabled: true, input: 8, id: 0x300, ide: false, interval: 100, triggerInput: 10 },
    { number: 2, name: 'b1', enabled: true, input: 8, id: 0x300, ide: false, interval: 100, triggerInput: t2 },
    { number: 3, name: 'other', enabled: true, input: 8, id: 0x300, ide: true, interval: 100, triggerInput: 0 }],
})
const runs = [[0x2000, 32, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]]
const up = { type: 'dingoPDM', family: 'upstream', outputs: [], paramRuns: runs }
const m = buildModel(up, funcs(0), vmap)
const o1 = m.nodes.get('canoutput:1')
assert.ok(o1.ins.some((p) => p.id === 'triggerInput' && p.optional), 'trigger port on a module with sub 12')
assert.ok(m.edges.some((e) => e.target === 'canoutput:1' && e.targetHandle === 'triggerInput' && e.idx === 10), 'trigger wired')
assert.match(o1.sub, /on a trigger/)
// without sub 12 (stock upstream) and on the fork: no port
const stock = { ...up, paramRuns: [[0x2000, 32, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }
assert.ok(!buildModel(stock, funcs(0), vmap).nodes.get('canoutput:1').ins.some((p) => p.id === 'triggerInput'))
assert.ok(!buildModel({ type: 'dingoPDM', version: 'v5.6.6', outputs: [] }, funcs(0), vmap).nodes.get('canoutput:1').ins.some((p) => p.id === 'triggerInput'))

// same frame (id + ID type): output 2 has no trigger, output 3 is a different (29-bit) frame
assert.deepEqual(framePeers(m, 'canoutput:1', o1.row), { triggered: [], untriggered: ['b1'] })
assert.deepEqual(framePeers(m, 'canoutput:2', m.nodes.get('canoutput:2').row), { triggered: ['cmd'], untriggered: [] })
assert.deepEqual(framePeers(buildModel(up, funcs(10), vmap), 'canoutput:1', o1.row), { triggered: ['b1'], untriggered: [] })

const words = (n) => sentenceFor(m, m.nodes.get(n)).map((s) => s.t ?? s.label).join(' ')
assert.match(words('canoutput:1'), /once each time btn turns on/)
assert.doesNotMatch(words('canoutput:1'), /every/)
assert.match(words('canoutput:2'), /every 100 ms/)
console.log('trigger.test.js ok')
