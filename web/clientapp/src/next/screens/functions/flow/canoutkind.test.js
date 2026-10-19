import assert from 'node:assert/strict'
import { coutKindProblem, snapChecksum, otherChecksums, hasCoutKind } from './canoutkind.js'

assert.equal(coutKindProblem({ kind: 0, startBit: 3, bitLength: 5 }), '')
assert.equal(coutKindProblem({ kind: 1, startBit: 8, bitLength: 4 }), '')   // a counter may be any width
assert.equal(coutKindProblem({ kind: 4, startBit: 16, bitLength: 8, byteOrder: 0 }), '')
assert.equal(coutKindProblem({ kind: 5, startBit: 23, bitLength: 8, byteOrder: 1 }), '')
assert.match(coutKindProblem({ kind: 2, startBit: 16, bitLength: 4 }), /8 bits/)
assert.match(coutKindProblem({ kind: 3, startBit: 28, bitLength: 8 }), /whole byte/)
assert.match(coutKindProblem({ kind: 4, startBit: 16, bitLength: 8, byteOrder: 1 }), /big endian/)
assert.deepEqual(snapChecksum({ kind: 4, startBit: 19, bitLength: 3, byteOrder: 0 }), { kind: 4, startBit: 16, bitLength: 8, byteOrder: 0 })
assert.equal(snapChecksum({ kind: 4, startBit: 19, bitLength: 3, byteOrder: 1 }).startBit, 23)
assert.equal(coutKindProblem(snapChecksum({ kind: 3, startBit: 61, bitLength: 2, byteOrder: 1 })), '')
const a = { id: 0x700, enabled: true, kind: 4 }, b = { id: 0x700, enabled: true, kind: 2 }, c = { id: 0x701, enabled: true, kind: 2 }
assert.deepEqual(otherChecksums([a, b, c], a), [b])
assert.equal(hasCoutKind({ family: 'fork' }), false)
assert.equal(hasCoutKind({ family: 'upstream', paramRuns: [[0x2000, 32, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]] }), true)
assert.equal(hasCoutKind({ family: 'upstream', paramRuns: [[0x2000, 32, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }), false)
console.log('canoutkind ok')
