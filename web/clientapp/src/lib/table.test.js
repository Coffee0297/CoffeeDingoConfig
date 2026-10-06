// Self-check: `node table.test.js`. Same cases as the firmware host self-test (CoffeeDingoFW
// tests/host_selftest.cpp) and the backend LookupTableTests, so the preview can't drift from the device.
import assert from 'node:assert/strict'
import { interpolate, spreadAxis, firstNonAscending } from './table.js'

const xs = [0, 10, 20, 0, 0, 0, 0, 0], ys = [0, 100, 0, 0, 0, 0, 0, 0]
const cells = new Array(64).fill(0)
for (let x = 0; x < 3; x++) { cells[x] = xs[x]; cells[8 + x] = 100 + xs[x] }   // row0: 0 10 20, row1: 100 110 120

const near = (a, b) => Math.abs(a - b) < 1e-6
assert.ok(near(interpolate(3, 2, xs, ys, cells, 0, 0), 0))
assert.ok(near(interpolate(3, 2, xs, ys, cells, 5, 0), 5))        // linear along x
assert.ok(near(interpolate(3, 2, xs, ys, cells, 15, 0), 15))
assert.ok(near(interpolate(3, 2, xs, ys, cells, 10, 50), 60))     // linear along y
assert.ok(near(interpolate(3, 2, xs, ys, cells, 5, 50), 55))      // bilinear
assert.ok(near(interpolate(3, 2, xs, ys, cells, -99, 0), 0))      // clamp low
assert.ok(near(interpolate(3, 2, xs, ys, cells, 999, 100), 120))  // clamp high
assert.ok(near(interpolate(3, 1, xs, ys, cells, 15, 12345), 15))  // 1-D ignores y
assert.ok(near(interpolate(0, 0, xs, ys, cells, 7, 7), 0))        // degenerate sizes -> cell[0][0]

assert.deepEqual(spreadAxis([0, 7, 7, 100, 9, 9, 9, 9], 4).slice(0, 4), [0, 100 / 3, 200 / 3, 100])
assert.equal(firstNonAscending([0, 10, 20], 3), -1)
assert.equal(firstNonAscending([0, 10, 10], 3), 2)

console.log('table.test OK')
