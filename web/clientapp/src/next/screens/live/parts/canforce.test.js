// node src/next/screens/live/parts/canforce.test.js — the force encoder against a copy of the firmware decoder.
import assert from 'node:assert/strict'
import { encodeForce, toRaw, fromRaw, parseHex, toHex } from './canforce.js'

// CoffeeDingoFW utils/dbc.cpp DecodeLE / DecodeBE (+ ApplyScaling), in BigInt for the 64-bit word.
function fwDecode(d, inp) {
  const n = inp.bitLength, s = inp.startBit
  let v = 0n
  if (inp.byteOrder === 1) {
    let byte = s >> 3, bit = s & 7
    for (let i = 0; i < n; i++) { if ((d[byte] >> bit) & 1) v |= 1n << BigInt(n - 1 - i); if (--bit < 0) { bit = 7; byte++ } }
  } else {
    let raw = 0n
    for (let i = 0; i < 8; i++) raw |= BigInt(d[i]) << BigInt(i * 8)
    v = (raw >> BigInt(s)) & ((1n << BigInt(n)) - 1n)
  }
  if (inp.signed && (v & (1n << BigInt(n - 1)))) v |= ~0n << BigInt(n)
  return Number(BigInt.asIntN(32, v)) * inp.factor + inp.offset
}

const I = (o) => ({ startBit: 0, bitLength: 8, byteOrder: 0, factor: 1, offset: 0, signed: false, ...o })
const cases = [
  [I({}), 200],
  [I({ startBit: 16, bitLength: 16 }), 6500],                         // Intel RPM
  [I({ startBit: 7, bitLength: 16, byteOrder: 1 }), 6500],            // Motorola from bit 7
  [I({ startBit: 21, bitLength: 11, byteOrder: 1 }), 1500],           // Motorola across bytes, odd start
  [I({ startBit: 5, bitLength: 12, factor: 0.1, offset: -40 }), 92.3],
  [I({ startBit: 8, bitLength: 16, signed: true, factor: 0.01 }), -12.34],
  [I({ startBit: 3, bitLength: 1 }), 1],
  [I({ startBit: 32, bitLength: 32, signed: true }), -123456789],
  [I({ startBit: 0, bitLength: 32 }), 2_000_000_000],
]
for (const [inp, v] of cases) {
  const d = encodeForce(inp, v)
  assert.equal(d.length, 8)
  assert.ok(Math.abs(fwDecode(d, inp) - v) < inp.factor / 2 + 1e-9, `${JSON.stringify(inp)} ${v} -> ${fwDecode(d, inp)}`)
}

// clamping to what the field can carry, and what the module will really read
assert.equal(toRaw(I({}), 300), 255)
assert.equal(toRaw(I({}), -5), 0)
assert.equal(toRaw(I({ signed: true }), -500), -128)
assert.equal(toRaw(I({ bitLength: 32 }), 5e9), 2 ** 31 - 1)
assert.equal(fwDecode(encodeForce(I({}), 300), I({})), 255)
assert.equal(fromRaw(I({ factor: 0.5, offset: 10 }), toRaw(I({ factor: 0.5, offset: 10 }), 20.3)), 20.5)

// neighbour bits keep the last-seen frame
const base = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
assert.deepEqual(encodeForce(I({ startBit: 8, bitLength: 8 }), 0, base), [0xff, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
assert.deepEqual(encodeForce(I({ startBit: 3, bitLength: 2 }), 0, base), [0xe7, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
assert.deepEqual(encodeForce(I({ startBit: 7, bitLength: 4, byteOrder: 1 }), 0, base), [0x0f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])

// a field past the 8th byte is refused, not wrapped
assert.throws(() => encodeForce(I({ startBit: 59, bitLength: 8, byteOrder: 1 }), 1))
assert.throws(() => encodeForce(I({ startBit: 60, bitLength: 8 }), 1))

assert.deepEqual(parseHex('0A 1b'), [10, 27])
assert.equal(toHex([10, 27]), '0A1B')
console.log('canforce ok')
