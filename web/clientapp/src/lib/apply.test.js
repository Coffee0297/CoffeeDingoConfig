// Self-check: `node apply.test.js`.
import assert from 'node:assert/strict'
import { matchOption, undoTemplate } from './apply.js'
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
console.log('apply ok')
