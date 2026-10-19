// Self-check: `node templates.test.js`.
import assert from 'node:assert/strict'
import { TEMPLATES, defaults, validate, previewTemplate, liveCtx, outputOptions, logicModule, shortfalls, freedBy, outputCircuit } from './templates.js'
import { pinFor, ioTag } from './pinmap.js'

const T = (k) => TEMPLATES.find((t) => t.key === k)
const head = T('headlights')

// validate: required fields, duplicate outputs
let s = defaults(head)
assert.match(validate(head, s), /Headlight switch/)
s = { ...s, low: 5, high: 6, lowL: 'p:1', lowR: 'p:2', highL: 'p:1' }
assert.match(validate(head, s), /twice/)
s.highL = 'p:3'
assert.equal(validate(head, s), '')

// preview: H4 adds the "low off while high" gate; high beam = high switch AND low
const num = { ...s, lowL: 1, lowR: 2, highL: 3, h4: true }
let p = await previewTemplate(head, num)
assert.deepEqual(p.ops.map((o) => o.name), ['Head High Sw', 'Head Low'])
assert.deepEqual(p.ops[0].ins, ['in:low', 'in:high'])
assert.deepEqual(p.wires, [{ out: 1, src: 'op2' }, { out: 2, src: 'op2' }, { out: 3, src: 'op1' }])
assert.deepEqual(p.need, { virtualInputs: 2 })
p = await previewTemplate(head, { ...num, h4: false, pass: 7, ign: 8 })
assert.deepEqual(p.ops.map((o) => o.name), ['Head Low On', 'Head High Sw', 'Head High'])
await assert.rejects(previewTemplate(head, { ...num, high: '', highL: 3 }), /High-beam outputs/)

// fuel pump: RPM condition and/or a digital run switch, at least one
const fp = T('fuelpump')
assert.match(validate(fp, { ...defaults(fp), output: 'p:1' }), /one of: Run signal/)
assert.equal(validate(fp, { ...defaults(fp), runSw: 5, output: 'p:1' }), '')
p = await previewTemplate(fp, { ...defaults(fp), runSw: 5, output: 1 })
assert.ok(!p.ops.some((o) => o.name === 'TP FuelRun') && p.ops.some((o) => o.name === 'TP FuelPump'))
p = await previewTemplate(fp, { ...defaults(fp), run: 4, runSw: 5, output: 1 })
assert.ok(p.ops.some((o) => o.name === 'TP FuelRun'))
// washer: wiper block + pump straight off the wash button
p = await previewTemplate(T('washwipe'), { slow: 5, wash: 6, park: 7, cycles: 3, slowOut: 1, pumpOut: 2 })
assert.equal(p.ops[0].op, 'wiper')
assert.deepEqual(p.wires, [{ out: 1, src: 'op1' }, { out: 2, src: 'in:wash' }])

// every template previews with its required fields filled
for (const t of TEMPLATES) {
  const v = defaults(t); let n = 1
  for (const f of t.fields) if (!f.opt && (f.t === 'bool' || f.t === 'num' || f.t === 'out')) v[f.k] = n++
  if (t.key === 'headlights') v.high = 9
  await previewTemplate(t, v)
}

assert.deepEqual(shortfalls({ timers: 2, virtualInputs: 1 }, { timers: [{ enabled: true }, { enabled: false }], virtualInputs: [{ enabled: false }] }), ['2 timers (1 free)'])
// an edit frees the old version's slots first
assert.deepEqual(freedBy({ guid: 'c', created: [{ kind: 'timer', number: 1 }, { kind: 'caninput', number: 2 }, { guid: 'p', kind: 'caninput', number: 3 }, { kind: 'wiper', number: 1 }] }),
  { c: { timers: 1, canInputs: 1 }, p: { canInputs: 1 } })
assert.deepEqual(shortfalls({ timers: 2 }, { timers: [{ enabled: true }, { enabled: false }] }, { timers: 1 }), [])

// live ctx against a fake module: creates in free slots, resolves indices, records what it made
const calls = []
let fx = { virtualInputs: [{ number: 1, enabled: true }, { number: 2, enabled: false }, { number: 3, enabled: false }], wiper: { enabled: false } }
const vm = () => [{ index: 1, name: 'Always On' }, ...fx.virtualInputs.map((v) => ({ index: 70 + v.number, kind: 'virtualinput', number: v.number, prop: 'State' })),
  { index: 159, kind: 'wiper', number: 1, prop: 'Slow Output' }]
const api = {
  functions: async () => structuredClone(fx), inputs: async () => vm(),
  setFunction: async (g, kind, n, body) => { calls.push([kind, n, body]); if (kind === 'virtualinput') fx.virtualInputs[n - 1].enabled = true; if (kind === 'wiper') fx.wiper.enabled = true },
}
const ctx = await liveCtx({ api, guid: 'p', wireOutput: async (n, i) => calls.push(['wire', n, i]) })
await head.build(ctx, { low: 5, high: 6, lowL: 1, highL: 3, h4: true })
assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['virtualinput', 2], ['virtualinput', 3], ['wire', 1], ['wire', 3]])
assert.deepEqual(calls[2], ['wire', 1, 73]); assert.deepEqual(calls[3], ['wire', 3, 72])
assert.deepEqual(ctx.created, [{ kind: 'virtualinput', number: 2, before: { number: 2, enabled: false } }, { kind: 'virtualinput', number: 3, before: { number: 3, enabled: false } }])
assert.deepEqual(ctx.wired, [1, 3])
await assert.rejects(head.build(ctx, { low: 5, high: 6, lowL: 1, highL: 3, h4: true }), /No free virtualInputs/)
const w = await ctx.wiper({ slowInput: 5 }); assert.equal(w.slow, 159)
await assert.rejects(ctx.wiper({}), /already in use/)

// a reused slot keeps its old fields: the condition must reset argOff (a leftover hysteresis release point)
const cc = []
const capi = { functions: async () => ({ conditions: [{ number: 1, enabled: false, argOff: 2 }] }), inputs: async () => [{ index: 20, kind: 'condition', number: 1, prop: 'Value' }],
  setFunction: async (g, kind, n, body) => cc.push(body) }
assert.equal(await (await liveCtx({ api: capi, guid: 'p' })).condition(9, 2, 2500, 'x'), 20)
assert.equal(cc[0].argOff, 2500)

// dash reset button: no output, runs on the picked PDM and sets its retry-all signal (upstream fault clear)
const ra = T('retryall')
assert.match(validate(ra, defaults(ra)), /PDM whose tripped outputs/)
assert.deepEqual(logicModule(ra, { pdm: 'p', button: 5 }), { guid: 'p' })
p = await previewTemplate(ra, { pdm: 'p', button: 5 })
assert.deepEqual(p.ops.map((o) => [o.op, o.ins]), [['retryall', ['in:button']]]); assert.deepEqual(p.need, {})
const dw = []
const rapi = { functions: async () => ({ device: { retryAllInput: 7 } }), inputs: async () => [], deviceInputs: async (g, b) => dw.push([g, b]) }
const rctx = await liveCtx({ api: rapi, guid: 'p' })
await ra.build(rctx, { pdm: 'p', button: 5 })
assert.deepEqual(dw, [['p', { retryAllInput: 5 }]]); assert.deepEqual(rctx.device, { retryAllInput: 7 })
await assert.rejects(ra.build(await liveCtx({ api: { ...rapi, functions: async () => ({ device: {} }) }, guid: 'p' }), { button: 5 }), /no retry-all input/)

// bus-wide outputs: pin, side, rating, free first
const pdm = { guid: 'p', name: 'PDM-01', type: 'dingoPDM' }, cb = { guid: 'c', name: 'CB-1', type: 'CANBoard' }
const oo = outputOptions([{ device: pdm, outs: [{ number: 1, name: 'Fuel Pump', input: 9, ratingA: 15 }] }, { device: cb, outs: [{ number: 2, name: '', input: 0 }] }], pinFor, ioTag)
assert.equal(oo[0].label, 'CB-1 · J4-4 DO2 · low-side · free')
assert.equal(oo[1].label, 'PDM-01 · J3-7 OUT1 · Fuel Pump · high-side 15 A · in use')
assert.equal(oo[1].value, 'p:1')

assert.deepEqual(logicModule(head, { lowL: 'p:1', highL: 'p:3' }), { guid: 'p' })
// outputs on two modules: the logic runs where most of them are (ties: the first picked), or on `logicOn`
assert.deepEqual(logicModule(head, { lowL: 'p:1', highL: 'c:3' }), { guid: 'p' })
assert.deepEqual(logicModule(head, { lowL: 'p:1', lowR: 'c:2', highL: 'c:3' }), { guid: 'c' })
assert.deepEqual(logicModule(T('relaywipe'), { runOut: 'c:1', fastOut: 'c:2', supplyOut: 'p:5' }), { guid: 'c' })
assert.deepEqual(logicModule(T('washwipe'), { slowOut: 'p:5', pumpOut: 'c:1', fastOut: 'c:2' }), { guid: 'p' })   // the wiper block's module

// relay-switched wiper: Ford holds RUN for a whole sweep on intermittent, standard just kicks it
const rw = T('relaywipe'), rwSel = { ...defaults(rw), low: 5, high: 6, int: 7, wash: 8, ign: 9, runOut: 'c:1', fastOut: 'c:2', supplyOut: 'p:5', pumpOut: 'p:6' }
let rp = await previewTemplate(rw, { ...rwSel, ford: true, sweep: 1600 })
assert.equal(rp.ops.find((o) => o.name === 'TP WipeInt').detail, '1600 / 3000 ms')
assert.equal(rp.ops.find((o) => o.name === 'TP WashWipe').detail, 'off-delay 3200 ms')                 // 2 wipes x sweep
assert.equal(rp.ops.find((o) => o.name === 'TP WipeSupply').detail, 'off-delay 3000 ms')
assert.deepEqual(rp.wires.map((w) => w.out), ['c:1', 'c:2', 'p:5', 'p:6'])
assert.equal((await previewTemplate(rw, { ...rwSel, ford: false })).ops.find((o) => o.name === 'TP WipeInt').detail, '400 / 3000 ms')
await assert.rejects(previewTemplate(rw, { ...rwSel, high: '' }), /FAST relay needs/)
assert.deepEqual(rp.need, { flashers: 1, timers: 2, virtualInputs: 5 })   // 4-way OR chains into 2 virtuals
// no ignition: the supply is simply always on
// a rotary stalk: positions become Conditions (OFF/INT/LOW/HIGH = 0/1/2/3 by default)
rp = await previewTemplate(rw, { ...rwSel, low: '', high: '', int: '', pos: 4, ford: true })
assert.deepEqual(rp.ops.filter((o) => o.op === 'condition').map((o) => o.detail), ['equals 2', 'equals 3', 'equals 1'])
assert.match(validate(rw, { ...defaults(rw), runOut: 'c:1' }), /one of: Wiper switch: low/)
rp = await previewTemplate(rw, { ...rwSel, ign: '', int: '', wash: '', pumpOut: '' })
assert.deepEqual(rp.wires.find((w) => w.out === 'p:5'), { out: 'p:5', src: 'on' })

// the other new ones build with a typical pick
const pv = async (k, extra) => previewTemplate(T(k), { ...defaults(T(k)), ...extra })
assert.deepEqual((await pv('radfan', { temp: 5, ac: 6, ign: 7, output: 'p:1' })).ops.map((o) => o.detail), ['greater than 95, off at 90', 'any of 2', 'off-delay 120000 ms', 'all of 2'])
await assert.rejects(pv('radfan', { temp: 5, on: 90, off: 95, output: 'p:1' }), /must be lower/)
assert.deepEqual((await pv('starter', { start: 5, ign: 6, neutral: 7, running: 8, output: 'p:1' })).ops.map((o) => o.op), ['virtual', 'timer', 'virtual'])
assert.equal((await pv('toggle', { button: 5, reset: 6, output: 'p:1' })).ops[0].detail, 'toggle')
assert.deepEqual((await pv('toggle', { button: 5, output: 'p:1' })).need, { counters: 1 })
assert.equal((await pv('reverse', { gear: 5, rev: 1, left: 'p:1' })).ops[0].detail, 'equals 1')
assert.match(validate(T('reverse'), { ...defaults(T('reverse')), left: 'p:1' }), /one of: Gear signal/)
assert.deepEqual((await pv('interior', { door1: 5, door2: 6, ign: 7, output: 'p:1' })).ops.map((o) => o.name), ['TP Door', 'TP DoorHold', 'TP DoorFade', 'TP Courtesy'])
assert.equal((await pv('brake', { brake: 5, left: 'p:1', right: 'p:2', third: 'c:1' })).wires.length, 3)
assert.deepEqual((await pv('drl', { ign: 5, lights: 6, left: 'p:1' })).ops.length, 1)
assert.deepEqual((await pv('reminder', { lights: 5, ign: 6, output: 'p:1' })).ops.map((o) => o.op), ['virtual', 'flasher'])
// allOf never leaves an empty middle slot: the firmware reads var1 always (index 0 = constant 0)
const vc = []
const vctx = await liveCtx({ api: { functions: async () => ({ virtualInputs: [1, 2, 3].map((number) => ({ number, enabled: false })) }), inputs: async () => [1, 2, 3].map((n) => ({ index: 70 + n, kind: 'virtualinput', number: n, prop: 'State' })).concat([{ index: 1, name: 'Always On' }]),
  setFunction: async (g, k, n, b) => vc.push(b) }, guid: 'p' })
await T('drl').build(Object.assign(vctx, { wireOutput: async () => {} }), { ign: 5, running: '', lights: 6, left: 'p:1' })
assert.deepEqual([vc[0].var0, vc[0].var1, vc[0].not1, vc[0].var2], [5, 6, true, 0])
assert.equal(await vctx.allOf([7], 'x'), 7)
await vctx.allOf([{ v: 8, not: true }], 'y'); assert.deepEqual([vc[1].var0, vc[1].not0, vc[1].var1], [8, true, 1])     // NOT x AND Always On

// PID fan: PI on a fixed setpoint (the target), fallback 100 % outside 1..200, output duty denominator 1
assert.deepEqual((await pv('pidfan', { temp: 5, output: 'p:1' })).need, { pids: 1 })
await assert.rejects(pv('pidfan', { temp: 5, target: 100, full: 90, output: 'p:1' }), /must be above/)
const pc = [], dutyCalls = []
const pctx = await liveCtx({ api: { functions: async () => ({ pids: [1, 2].map((number) => ({ number, enabled: number === 1 })) }), inputs: async () => [{ index: 230, kind: 'pid', number: 2, prop: 'Output' }, { index: 1, name: 'Always On' }],
  setFunction: async (g, k, n, b) => pc.push([k, n, b]) }, guid: 'p', outputDuty: async (o, d, on) => dutyCalls.push([o, d, on]) })
await T('pidfan').build(pctx, { temp: 5, target: 85, full: 105, ign: '', output: 'p:3' })
assert.deepEqual([pc[0][0], pc[0][1], pc[0][2].kp, pc[0][2].setpointInput, pc[0][2].setpoint, pc[0][2].feedForward, pc[0][2].invert, pc[0][2].ki, pc[0][2].iMin, pc[0][2].pvMin, pc[0][2].fallback],
  ['pid', 2, 5, 0, 85, 0, true, 0.25, 0, 1, 100])
assert.deepEqual(dutyCalls, [['p:3', 230, 1]])
await assert.rejects(T('pidfan').build(await liveCtx({ api: { functions: async () => ({ pids: null }), inputs: async () => [] }, guid: 'p' }), { temp: 5, target: 85, full: 105, output: 'p:3' }), /no PID block/)

// relay wiring adapts to the switching side
assert.deepEqual(outputCircuit('high', true).coil, ['OUT', 'GND'])
assert.deepEqual(outputCircuit('low', true).coil, ['+12V fused', 'OUT'])
assert.deepEqual(outputCircuit('low', false).load, ['+12V fused', 'OUT'])
console.log('templates ok')
