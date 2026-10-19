// node src/next/screens/functions/flow/latchgate.test.js — latch / gate block (upstream dingoFW feat/latch-gate-block)
import assert from 'node:assert/strict'
import { latchGateStep, latchGateProblem, latchGateIns } from './latchgate.js'
import { buildModel, slotUsage } from './model.js'
import { sentenceFor } from './sentence.js'
import { createSim } from './sim.js'

// the firmware's host self-test sequence (functions/latch_gate.cpp)
const L = { enabled: true, type: 0, timeMs: 100 }
let st = {}
assert.equal(latchGateStep(st, L, 1, 0, 0), 0)      // first pass: an input already on is not an edge
assert.equal(latchGateStep(st, L, 1, 0, 2), 0)
assert.equal(latchGateStep(st, L, 0, 0, 4), 0)
assert.equal(latchGateStep(st, L, 1, 0, 6), 1)      // set edge
assert.equal(latchGateStep(st, L, 0, 0, 8), 1)      // stays set
assert.equal(latchGateStep(st, L, 0, 1, 10), 0)     // reset edge
assert.equal(latchGateStep(st, L, 1, 1, 12), 1)     // set edge while reset is held
assert.equal(latchGateStep(st, L, 0, 0, 14), 1)
assert.equal(latchGateStep(st, L, 1, 1, 16), 0)     // both edges in one cycle: reset wins
assert.equal(latchGateStep(st, L, 0, 0, 18), 0)
assert.equal(latchGateStep(st, L, 1, 0, 20), 1)     // set at 20, input held on
assert.equal(latchGateStep(st, L, 1, 0, 119), 1)
assert.equal(latchGateStep(st, L, 1, 0, 120), 0)    // auto-cancel at exactly 100 ms
assert.equal(latchGateStep(st, L, 1, 0, 200), 0)    // the held input does not set it again
assert.equal(latchGateStep(st, { ...L, enabled: false }, 1, 0, 202), 0)
const G = { enabled: true, type: 1 }
st = {}
latchGateStep(st, G, 42, 1, 0)
assert.equal(latchGateStep(st, G, 42, 1, 2), 42)    // follows
assert.equal(latchGateStep(st, G, 7, 0, 4), 42)     // holds while disabled
assert.equal(latchGateStep(st, G, 7, 1, 6), 7)      // follows again

assert.equal(latchGateProblem({ type: 0, timeMs: 600000 }), null)
assert.match(latchGateProblem({ type: 0, timeMs: 600001 }), /600 s/)
assert.equal(latchGateProblem({ type: 1, timeMs: 1e9 }), null)   // a gate ignores the time
assert.deepEqual(latchGateIns({ type: 1 }).map((p) => p[1]), ['Value', 'Enable'])
assert.deepEqual(latchGateIns({ type: 0 }).map((p) => p[1]), ['Set', 'Reset'])

// flow model, sentence and the builder's simulator
const dev = { name: 'PDM', type: 'dingoPDM', outputs: [] }
const can = (n, id) => ({ number: n, enabled: true, id, bitLength: 8, operator: 2, operand: 0 })
const funcs = { canInputs: [can(1, 0x100), can(2, 0x101)], latchGates: [{ number: 1, name: 'Latch/Gate 1', enabled: true, type: 0, input: 7, controlInput: 9, timeMs: 1000 }, { number: 2, enabled: false, type: 1 }] }
const vmap = [{ index: 7, kind: 'caninput', number: 1, prop: 'State', type: 'bool', name: 'c1' }, { index: 8, kind: 'caninput', number: 1, prop: 'Value', type: 'float', name: 'c1 Value' },
  { index: 9, kind: 'caninput', number: 2, prop: 'State', type: 'bool', name: 'c2' }, { index: 10, kind: 'caninput', number: 2, prop: 'Value', type: 'float', name: 'c2 Value' },
  { index: 225, kind: 'latchgate', number: 1, prop: 'Value', type: 'float', name: 'Latch/Gate 1' }, { index: 226, kind: 'latchgate', number: 2, prop: 'Value', type: 'float', name: 'Latch/Gate 2' }]
const m = buildModel(dev, funcs, vmap)
const n = m.nodes.get('latchgate:1')
assert.equal(n.kindLabel, 'Latch / Gate')
assert.deepEqual(n.ins.map((p) => p.label), ['Set', 'Reset'])
assert.deepEqual(n.incomplete, [])
assert.equal(m.edges.some((e) => e.source === 'caninput:2' && e.target === 'latchgate:1'), true)
const text = sentenceFor(m, n).map((s) => s.t ?? s.label).join(' ')
assert.match(text, /turns on when CAN input 1 .*turns on , off when CAN input 2 .*reset wins.* or 1 s after it was set/)
assert.deepEqual(slotUsage(dev, funcs, {}).find((r) => r.arr === 'latchGates'), { label: 'Latch / Gate', arr: 'latchGates', used: 1, max: 2 })
assert.equal(slotUsage(dev, { ...funcs, latchGates: null }, {}).some((r) => r.arr === 'latchGates'), false)
assert.deepEqual(buildModel(dev, { ...funcs, latchGates: [{ ...funcs.latchGates[0], controlInput: 0, timeMs: 0 }] }, vmap).nodes.get('latchgate:1').incomplete, ['needs a reset input or an auto-cancel time'])
const g = buildModel(dev, { ...funcs, latchGates: [{ number: 1, name: 'Hold', enabled: true, type: 1, input: 8, controlInput: 9 }] }, vmap)
assert.deepEqual(g.nodes.get('latchgate:1').ins.map((p) => [p.label, p.accepts]), [['Value', 'num'], ['Enable', 'bool']])
assert.match(sentenceFor(g, g.nodes.get('latchgate:1')).map((s) => s.t ?? s.label).join(' '), /Hold follows .* while .* holds its last value/)

const sim = createSim(m, {})
sim.step()                                            // first pass samples
sim.setCan('caninput:1', 5); sim.step()
assert.equal(sim.vals[225], 1)
sim.setCan('caninput:1', 0); sim.step()
assert.equal(sim.vals[225], 1)                        // latched
sim.setCan('caninput:2', 5); sim.step()
assert.equal(sim.vals[225], 0)                        // reset
sim.setCan('caninput:2', 0); sim.setCan('caninput:1', 5); sim.step()
assert.equal(sim.vals[225], 1)
for (let i = 0; i < 20; i++) sim.step()               // 1 s later the auto-cancel turns it off
assert.equal(sim.vals[225], 0)
console.log('latchgate.test.js ok')
