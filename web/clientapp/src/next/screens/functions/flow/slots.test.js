// node src/next/screens/functions/flow/slots.test.js
import assert from 'node:assert/strict'
import { slotUsage } from './model.js'

const defs = { pdms: [{ typeName: 'dingoPDM', numConditions: 32, numTimers: 8 }], canboards: [{ typeName: 'CANBoard', numConditions: 8 }] }
const funcs = {
  conditions: [{ enabled: true }, { enabled: false }, { enabled: true }],
  timers: Array.from({ length: 8 }, () => ({ enabled: true })),
  maths: [{ enabled: true }, { enabled: false }],
  comfortBlinks: [{ enabled: false }],
}
const by = (rows, l) => rows.find((r) => r.label === l)

let r = slotUsage({ type: 'dingoPDM', version: 'v5.6.1' }, funcs, defs)
assert.deepEqual([by(r, 'Compare').used, by(r, 'Compare').max], [2, 32], 'max comes from the definition')
assert.deepEqual([by(r, 'Timers').used, by(r, 'Timers').max], [8, 8])
assert.equal(by(r, 'Math').max, 2, 'no definition count: the module\'s own slot count')
assert.ok(by(r, 'Comfort blink'))
assert.ok(!by(r, 'Counters'), 'a kind the module does not report is left out')

r = slotUsage({ type: 'dingoPDM', version: 'v5.5.112' }, funcs, defs)
assert.ok(!by(r, 'Math') && !by(r, 'Comfort blink'), 'older firmware: no 5.6 blocks')
r = slotUsage({ type: 'dingoPDM', version: 'v5.6.0' }, funcs, defs)
assert.ok(by(r, 'Math') && !by(r, 'Comfort blink'))

assert.equal(by(slotUsage({ type: 'CANBoard', version: 'v5.6.1' }, funcs, defs), 'Compare').max, 8, 'CANBoard limits')
console.log('slots.test.js ok')
