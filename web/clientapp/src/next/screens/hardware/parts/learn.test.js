// node src/next/screens/hardware/parts/learn.test.js
import assert from 'node:assert/strict'
import { createLearner } from './learn.js'

const hex = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ')
// 8 s at 10 snapshots a second: a switch bit flips four times, a counter runs, one bit is noise
function run(flipsAt) {
  const l = createLearner()
  for (let i = 0; i <= 80; i++) {
    const t = i * 100
    const on = flipsAt.filter((f) => t > f * 1000).length % 2 === 1
    l.feed([
      { dir: 'Rx', id: 0x3a1, ide: false, data: hex([0, on ? 0x10 : 0, 0, 0, 0, 0, 0, 0]), count: i },
      { dir: 'Rx', id: 0x1f0, ide: false, data: hex([i % 16, 0, 0, 0, 0, 0, 0, 0]), count: i },
      { dir: 'Rx', id: 0x551, ide: false, data: hex([0, 0, i % 2 ? 0x20 : 0, 0, 0, 0, 0, 0]), count: i },
      { dir: 'Tx', id: 0x700, ide: false, data: hex([i % 256, 0, 0, 0, 0, 0, 0, 0]), count: i },
    ], 1000 + t)
  }
  return l
}

let r = run([1.0, 2.2, 3.4, 4.6]).result()
assert.equal(r.cands[0].hex, '0x3A1'); assert.equal(r.cands[0].startBit, 12); assert.equal(r.cands[0].kind, 'best'); assert.equal(r.cands[0].changes, 4)
assert.ok(r.cands[0].percent >= 90)
assert.ok(r.ignored.some((x) => x.kind === 'counter' && x.hex === '0x1F0'), 'counter is listed and ignored')
assert.ok(r.ignored.some((x) => x.kind === 'noisy' && x.hex === '0x551'), 'noisy bit is listed and ignored')
assert.ok(!r.cands.some((x) => x.hex === '0x700'), 'frames the module sent itself (Tx) are not looked at')

// a bit that changed only once is not a switch that was flipped
r = run([2.0]).result()
assert.ok(!r.cands.some((x) => x.hex === '0x3A1' && x.kind === 'best'))

// nothing changes: no candidates
const l = createLearner()
for (let i = 0; i < 30; i++) l.feed([{ dir: 'Rx', id: 0x100, ide: false, data: '00 00 00 00 00 00 00 00', count: i }], i * 100)
assert.equal(l.result().cands.length, 0)
assert.equal(l.stats().ids, 1)

// 29-bit ids are kept apart from 11-bit ids with the same number
const m = createLearner()
m.feed([{ dir: 'Rx', id: 5, ide: false, data: '00 00', count: 1 }, { dir: 'Rx', id: 5, ide: true, data: '00 00', count: 1 }], 0)
m.feed([{ dir: 'Rx', id: 5, ide: false, data: '01 00', count: 2 }, { dir: 'Rx', id: 5, ide: true, data: '00 00', count: 2 }], 100)
assert.equal(m.stats().bits, 1)

console.log('learn.test.js ok')
