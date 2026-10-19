// node src/next/screens/hardware/parts/wireload.test.js — wire load % (upstream output sub 33, Msg 30) for display
import assert from 'node:assert/strict'
import { wireLoad, wireLoadText } from './wireload.js'

assert.equal(wireLoad({ thermalTau: 0, wireLoad: 50 }), null)                 // off: nothing shown
assert.deepEqual(wireLoad({ thermalTau: 30, wireLoad: 38.4 }), { pct: 38, headroom: 62, hot: false, over: false })
assert.equal(wireLoad({ thermalTau: 30, wireLoad: 80 }).hot, true)
assert.deepEqual(wireLoad({ thermalTau: 30, wireLoad: 255 }), { pct: 255, headroom: 0, hot: true, over: true })
assert.equal(wireLoadText(wireLoad({ thermalTau: 30, wireLoad: 38 })), 'wire 38 % · 62 % headroom')
assert.equal(wireLoadText(wireLoad({ thermalTau: 30, wireLoad: 104 })), 'wire 104 % · over its limit')
assert.equal(wireLoadText(null), '')
// the module's CAN ID span covers Msg 30 (+32) once its param list shows sub 33
const { spanAfter } = await import('../../../../lib/canids.js')
assert.equal(spanAfter('dingoPDM'), 30)
assert.equal(spanAfter('dingoPDM', { family: 'upstream', paramRuns: [[0x1000, 8, 0, 33]] }), 32)
assert.equal(spanAfter('dingoPDM', { family: 'upstream', paramRuns: [[0x1000, 8, 0, 18]] }), 30)
assert.equal(spanAfter('dingoPDM', { family: 'upstream', paramRuns: null }), 30)
assert.equal(spanAfter('CANBoard', { family: 'upstream', paramRuns: [[0x1000, 8, 0, 33]] }), 14)
console.log('wireload.test OK')
