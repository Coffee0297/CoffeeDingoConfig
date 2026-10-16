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

// from the backend's change history (G17): a 30 ms pulse between two polls still counts, and the frame
// before the first change seeds the comparison
const h = createLearner()
h.tick(1000)
h.feedChanges([
  { t: 1500, id: 0x3a1, ext: false, dir: 'Rx', data: '0010000000000000', prev: '0000000000000000' },
  { t: 1530, id: 0x3a1, ext: false, dir: 'Rx', data: '0000000000000000', prev: '0010000000000000' },
], 1600)
h.feedChanges([
  { t: 2500, id: 0x3a1, ext: false, dir: 'Rx', data: '0010000000000000', prev: '0000000000000000' },
  { t: 2530, id: 0x3a1, ext: false, dir: 'Rx', data: '0000000000000000', prev: '0010000000000000' },
], 9000)
r = h.result()
assert.equal(r.cands[0].hex, '0x3A1'); assert.equal(r.cands[0].startBit, 12); assert.equal(r.cands[0].changes, 4)
assert.equal(h.stats().seconds, 8)

console.log('learn.test.js ok')

// which CAN input already reads a learned bit
import { findReader } from './learn.js'
const mods = [{ guid: 'a', mod: 'PDM-01', canInputs: [
  { number: 1, name: 'Lights', enabled: true, id: 0x3a1, ide: false, startBit: 8, bitLength: 8, byteOrder: 0 },
  { number: 2, name: 'Hazard', enabled: true, id: 0x3a1, ide: false, startBit: 12, bitLength: 1, byteOrder: 0 },
  { number: 3, name: 'Off', enabled: false, id: 0x3a1, ide: false, startBit: 12, bitLength: 1 }] }]
assert.equal(findReader(mods, { id: 0x3a1, ide: false, startBit: 12 }).name, 'Hazard')                  // exact wins
assert.deepEqual(findReader(mods, { id: 0x3a1, ide: false, startBit: 9 }), { guid: 'a', mod: 'PDM-01', number: 1, name: 'Lights', exact: false })
assert.equal(findReader(mods, { id: 0x3a1, ide: true, startBit: 12 }), null)                            // 29-bit id differs
assert.equal(findReader(mods, { id: 0x3a2, ide: false, startBit: 12 }), null)
console.log('findReader ok')
