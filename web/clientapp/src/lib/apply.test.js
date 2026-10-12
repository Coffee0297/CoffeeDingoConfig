// Self-check: `node apply.test.js`.
import assert from 'node:assert/strict'
import { matchOption } from './apply.js'
import { list } from './runtime.js'

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
console.log('apply ok')
