// node src/next/screens/functions/flow/statesignals.test.js — an output's Warning / Open Load signals (upstream var
// map, feat/output-state-signals) in the simulator and the live values, and the backup-pump template built on them.
import assert from 'node:assert/strict'
import { createSim } from './sim.js'
import { liveOf } from './livevals.js'
import { TEMPLATES, previewTemplate, liveCtx } from '../../../../lib/templates.js'

const out = { enabled: true, inputVal: 5, currentLimit: 20, warnLimit: 0, openLoadLimit: 1, openLoadTime: 1000 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', enabled: true, outs: [{ prop: 'State', idx: 5 }] }],
  ['output:1', { id: 'output:1', kind: 'output', enabled: true, row: out,
    outs: [{ prop: 'On', idx: 10 }, { prop: 'Current', idx: 13 }, { prop: 'Warning', idx: 225 }, { prop: 'Open Load', idx: 226 }] }],
])
const sim = createSim({ nodes, byIdx: new Map() }, { 13: 7.5 })
const run = (ms) => { for (let k = 0; k < ms / 50; k++) sim.step(50) }
sim.set(5, true); run(100)
assert.deepEqual([sim.vals[225], sim.vals[226]], [false, false])
out.warnLimit = 5; run(50)
assert.deepEqual([sim.vals[225], sim.vals[226]], [true, false])
out.warnLimit = 0; sim.fault('output:1', 'open'); run(500)
assert.equal(sim.vals[226], false)                 // not missing for 1000 ms yet
run(600)
assert.deepEqual([sim.vals[225], sim.vals[226]], [false, true])
sim.set(5, false); run(50)
assert.equal(sim.vals[226], false)                 // off: nothing reported

const dev = { outputs: [{ number: 1, state: 'OpenLoad' }, { number: 2, state: 'Warning' }] }
assert.equal(liveOf({ kind: 'output', number: 1, prop: 'Open Load' }, new Map(), dev), true)
assert.equal(liveOf({ kind: 'output', number: 1, prop: 'Warning' }, new Map(), dev), false)
assert.equal(liveOf({ kind: 'output', number: 2, prop: 'Warning' }, new Map(), dev), true)

// backup pump: backup = demand AND (main Open Load OR main Fault); the main pump's signals come from its module
const bp = TEMPLATES.find((t) => t.key === 'backuppump')
const p = await previewTemplate(bp, { run: 5, main: 'p:1', backup: 'p:2' })
assert.deepEqual(p.ops.map((o) => [o.name, o.ins]), [['TP MainPumpLost', ['out:p:1', 'out:p:1']], ['TP BackupPump', ['in:run', 'op1']]])
assert.deepEqual(p.wires, [{ out: 'p:1', src: 'in:run' }, { out: 'p:2', src: 'op2' }])

const fx = { virtualInputs: [1, 2].map((n) => ({ number: n, enabled: false })) }
const vmap = (sigs) => [{ index: 1, name: 'Always On' }, { index: 90, kind: 'output', number: 1, prop: 'Fault' }, ...sigs,
  ...fx.virtualInputs.map((v) => ({ index: 70 + v.number, kind: 'virtualinput', number: v.number, prop: 'State' }))]
const calls = []
let sigs = [{ index: 226, kind: 'output', number: 1, prop: 'Open Load' }]
const api = { functions: async () => structuredClone(fx), inputs: async () => vmap(sigs),
  setFunction: async (g, kind, n, body) => { calls.push([kind, n, body]); fx.virtualInputs[n - 1].enabled = true } }
await bp.build(await liveCtx({ api, guid: 'p', wireOutput: async (o, i) => calls.push(['wire', o, i]) }), { run: 5, main: 'p:1', backup: 'p:2' })
const vi = (c) => [c[0], c[1], c[2].var0, c[2].var1, c[2].cond0]
assert.deepEqual(calls[0], ['wire', 'p:1', 5])
assert.deepEqual(vi(calls[1]), ['virtualinput', 1, 226, 90, 1])   // Open Load OR Fault
assert.deepEqual(vi(calls[2]), ['virtualinput', 2, 5, 71, 0])     // demand AND lost
assert.deepEqual(calls[3], ['wire', 'p:2', 72])
// a CANBoard main pump has neither signal
sigs = []; fx.virtualInputs.forEach((v) => (v.enabled = false))
const cb = { ...api, inputs: async () => [{ index: 1, name: 'Always On' }] }
await assert.rejects(bp.build(await liveCtx({ api: cb, guid: 'p', wireOutput: async () => {} }), { run: 5, main: 'p:1', backup: 'p:2' }), /dingoPDM output/)
console.log('statesignals.test OK')
