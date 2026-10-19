// node src/lib/loadshed.test.js — the Load shed (low battery) template: per-priority battery conditions + on-delay,
// priority 1 through the module's own shed input where the firmware has it (upstream feat/load-shed), else AND NOT
// into each output's rule; the live build against a fake PDM.
import assert from 'node:assert/strict'
import { TEMPLATES, defaults, validate, previewTemplate, liveCtx, logicModule, canShedOut } from './templates.js'

const tpl = TEMPLATES.find((t) => t.key === 'loadshed')
const sel = { ...defaults(tpl), pdm: 'g', out1: 'g:3', pr1: 1, out2: 'g:4', pr2: 2 }
assert.equal(validate(tpl, sel), '')
assert.deepEqual(logicModule(tpl, sel), { guid: 'g' })
const name = (o) => 'out ' + o.split(':')[1]

// no native shedding: two priorities, each a condition (+ hysteresis) and an on-delay, AND NOT into the rules
let p = await previewTemplate(tpl, sel, name)
assert.deepEqual(p.ops.filter((o) => o.op !== 'signal').map((o) => [o.op, o.detail]), [
  ['condition', 'less than 12, off at 12.6'], ['timer', 'on-delay 10000 ms'],
  ['condition', 'less than 11.6, off at 12.2'], ['timer', 'on-delay 10000 ms'],
  ['virtual', 'all of 2'], ['virtual', 'all of 2']])
assert.equal(p.wires.length, 2); assert.ok(!p.wires.some((w) => w.shed))
// native: priority 1 opts in to the module's shed input, priority 2 still ANDs NOT
p = await previewTemplate(tpl, sel, name, { canShed: (o) => o === 'g:3' })
assert.ok(p.ops.some((o) => o.op === 'loadshed'))
assert.deepEqual(p.wires.map((w) => [w.out, !!w.shed]), [['g:4', false], ['g:3', true]])
await assert.rejects(previewTemplate(tpl, { ...sel, back: 11 }, name), /Back on above/)
await assert.rejects(previewTemplate(tpl, { ...sel, out2: 'h:1' }, name), /not on the PDM picked/)

// canShedOut: the module's shed input (device 0x0000:13) and the output's sub 26
const up = { family: 'upstream', shedInput: 0, paramRuns: [[0x1000, 8, 0, 26]] }
assert.equal(canShedOut(up, 2), true)
assert.equal(canShedOut({ ...up, paramRuns: [[0x1000, 8, 0, 25]] }, 2), false)
assert.equal(canShedOut({ ...up, shedInput: null }, 2), false)
assert.equal(canShedOut({ family: 'fork', shedInput: null }, 2), false)

// live, native path for output 3, AND NOT for output 4 (whose rule is var 40)
const calls = []
const fx = { conditions: [1, 2].map((number) => ({ number, enabled: false })), timers: [1, 2].map((number) => ({ number, enabled: false })),
  virtualInputs: [{ number: 1, enabled: false }], device: { shedInput: 0 } }
const vm = () => [{ index: 1, name: 'Always On', kind: 'sys' }, { index: 4, name: 'Battery Voltage', kind: 'sys' },
  ...[1, 2].map((n) => ({ index: 100 + n, kind: 'condition', number: n, prop: 'Value' })), ...[1, 2].map((n) => ({ index: 200 + n, kind: 'timer', number: n, prop: 'State' })),
  { index: 71, kind: 'virtualinput', number: 1, prop: 'State' }]
const api = {
  functions: async () => structuredClone(fx), inputs: async () => vm(),
  setFunction: async (g, kind, n, body) => { calls.push([kind, n, body]); ({ condition: fx.conditions, timer: fx.timers, virtualinput: fx.virtualInputs })[kind][n - 1].enabled = true },
  deviceInputs: async (g, b) => calls.push(['device', b]), outputConfig: async (g, b) => calls.push(['output', b]),
}
const ctx = await liveCtx({ api, guid: 'g', outName: name, inputOf: (o) => (o === 'g:4' ? 40 : 0), canShed: (o) => o === 'g:3', wireOutput: async (o, i) => calls.push(['wire', o, i]) })
await tpl.build(ctx, sel)
const cond = calls.filter((c) => c[0] === 'condition').map((c) => c[2])
assert.deepEqual(cond.map((c) => [c.input, c.operator, c.arg, c.argOff]), [[4, 3, 12, 12.6], [4, 3, 11.6, 12.2]])
assert.deepEqual(calls.filter((c) => c[0] === 'timer').map((c) => [c[2].input, c[2].mode, c[2].preset]), [[101, 0, 10000], [102, 0, 10000]])
const v = calls.find((c) => c[0] === 'virtualinput')[2]
assert.deepEqual([v.var0, v.not0, v.var1, v.not1], [40, false, 202, true])        // output 4: its rule AND NOT shed 2
assert.deepEqual(calls.find((c) => c[0] === 'wire'), ['wire', 'g:4', 71])
assert.deepEqual(calls.find((c) => c[0] === 'device'), ['device', { shedInput: 201 }])
assert.deepEqual(calls.find((c) => c[0] === 'output'), ['output', { Number: 3, Shed: true }])
assert.deepEqual(ctx.device, { shedInput: 0 })                                   // put back on a remove
// an output with nothing driving it cannot be ANDed
const ctx2 = await liveCtx({ api, guid: 'g', outName: name, inputOf: () => 0, canShed: () => false, wireOutput: async () => {} })
await assert.rejects(tpl.build(ctx2, { ...sel, out2: '' }), /nothing driving it/)
// flow simulator + sentences: an opted-in output is held off while the shed input is on, the other one is not
const { createSim } = await import('../next/screens/functions/flow/sim.js')
const { sentenceFor } = await import('../next/screens/functions/flow/sentence.js')
const o1 = { enabled: true, inputVal: 1, shed: true }, o2 = { enabled: true, inputVal: 1, shed: false }
const nodes = new Map([
  ['sys', { id: 'sys', kind: 'sys', title: 'PDM-01', enabled: true, row: { shedInput: 6 }, outs: [{ prop: 'Value', idx: 1, label: 'Always on' }] }],
  ['input:1', { id: 'input:1', kind: 'input', title: 'Batt low', enabled: true, outs: [{ prop: 'State', idx: 6, label: 'State' }] }],
  ['output:1', { id: 'output:1', kind: 'output', title: 'Seat heater', enabled: true, row: o1, outs: [{ prop: 'On', idx: 10 }] }],
  ['output:2', { id: 'output:2', kind: 'output', title: 'ECU', enabled: true, row: o2, outs: [{ prop: 'On', idx: 11 }] }],
])
const model = { nodes, byIdx: new Map([[1, { kind: 'sys', name: 'Always On' }], [6, { kind: 'input', number: 1 }]]) }
const sim = createSim(model, {})
sim.set(1, true); sim.step(50)
assert.equal(sim.status['output:1'].text, 'ON')
sim.set(6, true); sim.step(50)
assert.equal(sim.status['output:1'].text, 'SHED'); assert.equal(sim.vals[10], false)
assert.equal(sim.status['output:2'].text, 'ON')
sim.set(6, false); sim.step(50)
assert.equal(sim.status['output:1'].text, 'ON')
const txt = (n) => sentenceFor(model, n)?.map((s) => s.t ?? s.label).join(' ')
assert.equal(txt(nodes.get('sys')), 'While Batt low is on, PDM-01 holds every output set to shed off (load shedding).')
assert.match(txt(nodes.get('output:1')), /switches off while the module sheds loads/)
assert.doesNotMatch(txt(nodes.get('output:2')), /sheds/)
console.log('loadshed.test OK')
