// node src/next/screens/power/parts/wakeFrame.test.js — wake frame packing, validation, frame fill and match
import assert from 'node:assert/strict'
import { parseByte, byteText, problem, writes, fromFrame, matches } from './wakeFrame.js'

const wf = { enabled: true, id: 0x321, ext: false, minLength: 2, mask: [0xff, 0, 0, 0, 0, 0, 0, 0xf0], value: [0xaa, 0, 0, 0, 0, 0, 0, 0x30] }
assert.equal(parseByte('ff'), 255); assert.equal(parseByte('0x1A'), 26); assert.equal(parseByte('100'), null); assert.equal(parseByte(''), null)
assert.equal(byteText(10), '0A')
assert.equal(problem(wf), '')
assert.match(problem({ ...wf, id: 0x800 }), /7FF/)
assert.equal(problem({ ...wf, id: 0x800, ext: true }), '')
assert.match(problem({ ...wf, minLength: 9 }), /0 to 8/)
const w = writes(wf)
assert.deepEqual(w.map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 0])   // enable last
assert.equal(w[3][1], 0xff)                 // mask Lo: byte 0 in the low byte
assert.equal(w[4][1], 0xf0000000)           // mask Hi: byte 7 in the top byte, unsigned
assert.equal(w[6][1], 0x30000000)
const f = { id: 0x321, ext: false, len: 3, data: 'AA 01 02' }
assert.equal(matches(wf, f), false)        // byte 7 reads 0 past the length: 0 & F0 != 30
assert.equal(matches({ ...wf, mask: [0xff, 0, 0, 0, 0, 0, 0, 0] }, f), true)
assert.equal(matches({ ...wf, mask: [0xff, 0, 0, 0, 0, 0, 0, 0] }, { ...f, data: 'AB 01 02' }), false)
assert.equal(matches({ ...wf, mask: [0xff, 0, 0, 0, 0, 0, 0, 0] }, { ...f, len: 1, data: 'AA' }), false)   // too short
assert.equal(matches({ ...wf, mask: [0xff, 0, 0, 0, 0, 0, 0, 0] }, { ...f, ext: true }), false)
const filled = fromFrame({ ...wf, mask: [1, 2, 3, 4, 5, 6, 7, 8] }, { id: 0x18FF0001, ext: true, len: 3, data: 'AA 01 02' })
assert.deepEqual([filled.id, filled.ext, filled.minLength, filled.value], [0x18ff0001, true, 3, [0xaa, 1, 2, 0, 0, 0, 0, 0]])
assert.deepEqual(filled.mask, [1, 2, 3, 4, 5, 6, 7, 8])   // masks kept
console.log('wakeFrame.test.js ok')
