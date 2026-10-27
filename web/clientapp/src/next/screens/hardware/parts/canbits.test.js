// node src/next/screens/hardware/parts/canbits.test.js
import assert from 'node:assert/strict'
import { signalBits, decodeRaw, decode, compare, parseBytes } from './canbits.js'

const fr = parseBytes('34 12 00 00 00 00 80 FF')
// little-endian 16 bits at bit 0 = 0x1234
assert.equal(decodeRaw(fr, 0, 16, 0, false), 0x1234)
assert.deepEqual(signalBits(0, 16, 0).slice(0, 2), [15, 14]); assert.equal(signalBits(0, 16, 0).length, 16)
// big-endian 16 bits, start bit 7 (MSB of byte 0) = bytes 0,1 as 0x3412
assert.equal(decodeRaw(fr, 7, 16, 1, false), 0x3412)
assert.deepEqual(signalBits(7, 16, 1), [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8])
// a single bit
assert.equal(decodeRaw(parseBytes('00 10'), 12, 1, 0, false), 1)
assert.equal(decodeRaw(parseBytes('00 10'), 12, 1, 1, false), 1)
// signed: 0xFF80 little-endian at bit 48 = -128
assert.equal(decodeRaw(fr, 48, 16, 0, true), -128)
assert.equal(decodeRaw(fr, 48, 16, 0, false), 0xff80)
// 32-bit unsigned above 2^31 reads negative, as the firmware's int32 cast
assert.equal(decodeRaw(parseBytes('00 00 00 80'), 0, 32, 0, false), -2147483648)
// bits past the frame read 0 (little-endian) and are not highlighted
assert.equal(decodeRaw(parseBytes('00 00 00 00 00 00 00 FF'), 60, 8, 0, false), 0x0f)
assert.equal(signalBits(60, 8, 0).length, 4)
assert.equal(signalBits(3, 8, 1).length, 8); assert.deepEqual(signalBits(3, 8, 1).slice(3, 6), [0, 15, 14])
// scaling: 0x1234 × 0.1 − 40 = 426.0, in 32-bit float
const d = decode(fr, { startBit: 0, bitLength: 16, byteOrder: 0, signed: false, factor: 0.1, offset: -40 })
assert.equal(d.raw, 4660); assert.ok(Math.abs(d.value - 426) < 1e-3); assert.equal(d.value, Math.fround(d.value))
// on/off rule; the operand is a float on the module, so 0.1 matches raw 1 × 0.1
assert.ok(compare(decode(parseBytes('01'), { startBit: 0, bitLength: 8, byteOrder: 0, factor: 0.1, offset: 0 }).value, 0, 0.1))
// on/off rule
assert.ok(compare(5, 1, 0)); assert.ok(!compare(0, 1, 0)); assert.ok(compare(6, 6, 2)); assert.ok(compare(4, 7, 2)); assert.ok(compare(3, 4, 3))
// parse
assert.deepEqual(parseBytes('a'), [10, 0, 0, 0, 0, 0, 0, 0]); assert.ok(Number.isNaN(parseBytes('zz')[0]))
// against a line-by-line copy of CoffeeDingoFW utils/dbc.cpp DecodeLE / DecodeBE, random frames and fields
function fwDecode(d, sb, bl, be, signed) {
  let value = 0n
  if (!be) {
    let raw = 0n
    for (let i = 0; i < 8; i++) raw |= BigInt(d[i]) << BigInt(i * 8)
    value = (raw >> BigInt(sb)) & ((1n << BigInt(bl)) - 1n)
  } else {
    let byteIndex = sb >> 3, bitIndex = sb % 8
    for (let i = 0; i < bl; i++) { if ((d[byteIndex] >> bitIndex) & 1) value |= 1n << BigInt(bl - 1 - i); if (--bitIndex < 0) { bitIndex = 7; byteIndex++ } }
  }
  if (signed && value & (1n << BigInt(bl - 1))) value |= (0xFFFFFFFFFFFFFFFFn << BigInt(bl)) & 0xFFFFFFFFFFFFFFFFn
  return Number(BigInt.asIntN(32, value))
}
let seed = 7
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
for (let k = 0; k < 5000; k++) {
  const d = Array.from({ length: 8 }, () => rnd(256)), be = rnd(2), bl = 1 + rnd(32), signed = !!rnd(2)
  const sb = rnd(64)
  if (be && signalBits(sb, bl, 1).length < bl) continue   // the firmware would read past byte 7
  assert.equal(decodeRaw(d, sb, bl, be, signed), fwDecode(d, sb, bl, be, signed), JSON.stringify({ d, sb, bl, be, signed }))
}
console.log('canbits.test.js ok')
