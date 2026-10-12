// Self-check: `node apply.test.js`.
import assert from 'node:assert/strict'
import { matchOption, undoTemplate, followSignal, remoteShortfalls, trackWrites } from './apply.js'
import { TEMPLATES } from './templates.js'
import { list, merged } from './runtime.js'

const opts = [
  { value: 'p:1', label: 'PDM-01 · J3-1 OUT9' }, { value: 'p:2', label: 'PDM-01 · J3-10 OUT3' },
  { value: 'c:1', label: 'CB-1 · J3-3 DI3 · digitalInput3  (over CAN)' }, { value: 7, label: 'PDM-01 · J3-8 DI1 · Ignition' },
]
assert.equal(matchOption(opts, 'PDM-01 J3-1').value, 'p:1')          // whole token beats a prefix (J3-10)
assert.equal(matchOption(opts, 'cb-1 di3').value, 'c:1')
assert.equal(matchOption(opts, 'ignition').value, 7)
assert.equal(matchOption(opts, 7).value, 7)
assert.match(matchOption(opts, 'PDM-01').error, /matches 3/)
assert.match(matchOption(opts, 'nope').error, /nothing matches/)
const cat = JSON.parse(list())
assert.ok(cat.templates.find((t) => t.key === 'headlights').fields.some((f) => f.field === 'lowL' && f.type === 'out'))
assert.equal(matchOption(opts, 'c:1').value, 'c:1')                  // a stored value resolves as itself
// edit: stored picks/settings/relays stay unless the request overrides them
const m = merged({ key: 'headlights', sel: { low: 7, lowL: 'p:1', highL: 'p:2', pass: '', h4: true }, relays: { lowL: true } },
  { id: 'x', picks: { pass: 'CB-1 DI5' }, relays: { lowL: false } })
assert.deepEqual([m.key, m.picks.low, m.picks.lowL, m.picks.pass, m.settings.h4, m.relays.lowL], ['headlights', 7, 'p:1', 'CB-1 DI5', true, false])
assert.equal(merged({ key: 'simple', name: 'Horn', sel: {} }, {}).name, 'Horn')                  // an edit keeps the name
// remove puts every touched thing back as it was: output in full (enabled, PWM), slot contents, pin name
const w = []
const fake = { setFunction: async (g, k, n, b) => w.push([k, n, b]), outputConfig: async (g, b) => w.push(['out', b.Number, b]) }
await undoTemplate(fake, [{ guid: 'p', type: 'dingoPDM' }], { guid: 'p', wired: [2], prev: { 2: 0 },
  outs: { 2: { number: 2, enabled: false, inputVal: 0, currentLimit: 8 } },
  created: [{ kind: 'condition', number: 1, before: { number: 1, enabled: false, argOff: 2 } }, { kind: 'caninput', number: 3, before: { name: 'x', ide: true, id: 9 } }],
  enabled: [{ guid: 'c', kind: 'input', number: 4, name: 'digitalInput4' }] })
assert.deepEqual(w.map((x) => x.slice(0, 2)), [['out', 2], ['caninput', 3], ['condition', 1], ['input', 4]])
assert.equal(w[0][2].Enabled, false)                                           // the spare stays disabled
assert.deepEqual(w[2][2], { number: 1, enabled: false, argOff: 2 })
assert.deepEqual(Object.keys(w[1][2]), ['name', 'id', 'ide'])                   // id before ide
assert.deepEqual(w[3][2], { enabled: false, name: 'digitalInput4' })
// an output on another module follows the logic module's broadcast through a CAN input there
const made = []
const fapi = {
  inputs: async (g) => g === 'L' ? [{ index: 1, name: 'Always On' }, { index: 57, kind: 'virtualinput', number: 2, prop: 'State', name: 'TP WipeRun' }, { index: 81, kind: 'timer', number: 2, prop: 'State', name: 'TP WipeSupply' }]
    : [{ index: 1, name: 'Always On' }, { index: 9, name: 'CB-2 TP WipeSupply' }],
  broadcastSignals: async () => [{ name: 'VirtualInput2', offset: 5, startBit: 33, bitLength: 1, byteOrder: 0, factor: 1, valueOffset: 0, signed: false }, { name: 'Timer2.State', offset: 4, startBit: 29, bitLength: 1, byteOrder: 0, factor: 1, valueOffset: 0, signed: false }],
  functions: async () => ({ canInputs: [{ number: 1, enabled: true, id: 1, startBit: 0, bitLength: 8 }, { number: 2, enabled: false, name: 'canInput2' }] }),
  setFunction: async (g, k, n, b) => made.push([g, k, n, b]),
}
const L = { guid: 'L', name: 'CB-2', baseId: 1648 }, P = { guid: 'P', name: 'PDM-03' }
let fr = await followSignal(fapi, L, P, 81)
assert.deepEqual([made[0][0], made[0][1], made[0][2], made[0][3].id, made[0][3].startBit, made[0][3].name], ['P', 'caninput', 2, 1652, 29, 'CB-2 TP WipeSupply'])
assert.equal(fr.stateIndex, 9); assert.equal(fr.before.name, 'canInput2')
assert.deepEqual(await followSignal(fapi, L, P, 1), { stateIndex: 1 })                           // Always On: the remote's own
await assert.rejects(followSignal({ ...fapi, broadcastSignals: async () => [] }, L, P, 57), /does not broadcast/)
const rwT = TEMPLATES.find((t) => t.key === 'relaywipe')
assert.deepEqual(remoteShortfalls(rwT, { runOut: 'L:1', supplyOut: 'P:5', pumpOut: 'P:6' }, 'L', { P: { canInputs: [{ enabled: false }] } }, [P]), ['PDM-03: 2 CAN inputs (1 free)'])
// undo across modules: remote output + its follower CAN input; older instances keyed outputs by bare n
const u = []
const uapi = { setFunction: async (g, k, n, b) => u.push([g, k, n]), outputConfig: async (g, b) => u.push([g, 'out', b.Number]) }
await undoTemplate(uapi, [{ guid: 'L', type: 'CANBoard' }, { guid: 'P', type: 'dingoPDM' }], { guid: 'L', wired: ['L:1', 'P:5', 3], prev: { 3: 0 },
  outs: { 'L:1': { number: 1 }, 'P:5': { number: 5, currentLimit: 8 } }, created: [{ guid: 'P', kind: 'caninput', number: 2, before: { id: 0, ide: false } }], cans: ['P|2'] })
assert.deepEqual(u, [['L', 'digitaloutput', 3], ['L', 'digitaloutput', 1], ['P', 'out', 5], ['P', 'caninput', 2]])
// a module that drops off the bus mid-way (written:false after live writes) is reported
let live = true
const [tw, partial] = trackWrites({ setFunction: async () => ({ ok: true, written: live }), outputConfig: async () => ({ ok: true }) }, [{ guid: 'a', name: 'PDM-04' }, { guid: 'b', name: 'CB-2' }])
await tw.setFunction('a', 'timer', 1, {}); await tw.setFunction('b', 'timer', 1, {}); live = false; await tw.setFunction('a', 'counter', 1, {})
assert.deepEqual(partial(), ['PDM-04'])
await tw.setFunction('c', 'timer', 1, {})                                  // a module that was away the whole time
assert.deepEqual(partial(), ['PDM-04', 'c'])
const [tw2, p2] = trackWrites({ setFunction: async () => ({ ok: true, written: false }) }, [])
await tw2.setFunction('a', 'timer', 1, {}); assert.deepEqual(p2(), [])         // all offline = an offline edit
// a shared CAN input outlives its creator: the template still using it inherits it, and restores it later
const A = { guid: 'p', created: [{ kind: 'caninput', number: 5, before: { id: 0, ide: false, enabled: false } }], cans: [5] }, B = { guid: 'p', created: [], cans: [5] }
const w2 = []; const a2 = { setFunction: async (g, k, n, b) => w2.push([k, n]), outputConfig: async () => ({}) }
await undoTemplate(a2, [{ guid: 'p', type: 'dingoPDM' }], A, [B])
assert.deepEqual(w2, []); assert.deepEqual(B.created.map((c) => [c.guid, c.number]), [['p', 5]])
await undoTemplate(a2, [{ guid: 'p', type: 'dingoPDM' }], B, [])
assert.deepEqual(w2, [['caninput', 5]])
console.log('apply ok')
