// Self-check: `node apply.test.js`.
import assert from 'node:assert/strict'
import { matchOption } from './apply.js'
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
console.log('apply ok')
