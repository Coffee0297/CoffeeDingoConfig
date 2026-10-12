// Self-check: `node templates.test.js`.
import assert from 'node:assert/strict'
import { TEMPLATES, defaults, validate, previewTemplate, liveCtx, outputOptions, logicModule, shortfalls, outputCircuit } from './templates.js'
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
assert.deepEqual(ctx.created, [{ kind: 'virtualinput', number: 2 }, { kind: 'virtualinput', number: 3 }])
assert.deepEqual(ctx.wired, [1, 3])
await assert.rejects(head.build(ctx, { low: 5, high: 6, lowL: 1, highL: 3, h4: true }), /No free virtualInputs/)
const w = await ctx.wiper({ slowInput: 5 }); assert.equal(w.slow, 159)
await assert.rejects(ctx.wiper({}), /already in use/)

// bus-wide outputs: pin, side, rating, free first
const pdm = { guid: 'p', name: 'PDM-01', type: 'dingoPDM' }, cb = { guid: 'c', name: 'CB-1', type: 'CANBoard' }
const oo = outputOptions([{ device: pdm, outs: [{ number: 1, name: 'Fuel Pump', input: 9, ratingA: 15 }] }, { device: cb, outs: [{ number: 2, name: '', input: 0 }] }], pinFor, ioTag)
assert.equal(oo[0].label, 'CB-1 · J4-4 DO2 · low-side · free')
assert.equal(oo[1].label, 'PDM-01 · J3-7 OUT1 · Fuel Pump · high-side 15 A · in use')
assert.equal(oo[1].value, 'p:1')

assert.deepEqual(logicModule(head, { lowL: 'p:1', highL: 'p:3' }), { guid: 'p' })
assert.ok(logicModule(head, { lowL: 'p:1', highL: 'c:3' }).error)

// relay wiring adapts to the switching side
assert.deepEqual(outputCircuit('high', true).coil, ['OUT', 'GND'])
assert.deepEqual(outputCircuit('low', true).coil, ['+12V fused', 'OUT'])
assert.deepEqual(outputCircuit('low', false).load, ['+12V fused', 'OUT'])
console.log('templates ok')
