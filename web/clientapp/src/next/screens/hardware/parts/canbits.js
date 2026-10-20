// CAN signal decode for the CAN input editor's test bytes. Pure. Mirrors the firmware (utils/dbc.cpp):
// little-endian = start bit is the lowest bit, counting up through the 64-bit frame (byte 0 first);
// big-endian (Motorola, DBC style) = start bit is the highest bit, counting down inside a byte and on to
// bit 7 of the next byte. value = raw × factor + offset, in 32-bit float; raw is cast to int32 as the firmware does.

/** Frame positions (byte × 8 + bit) of a signal, most significant first. Bits past byte 7 are left out. */
export function signalBits(startBit, bitLength, byteOrder) {
  const sb = Math.trunc(Number(startBit) || 0), bl = Math.trunc(Number(bitLength) || 0)
  const out = []
  if (bl < 1 || bl > 32 || sb < 0 || sb > 63) return out
  if (Number(byteOrder) === 1) {
    let byte = sb >> 3, bit = sb & 7
    for (let i = 0; i < bl; i++) { if (byte <= 7) out.push(byte * 8 + bit); if (--bit < 0) { bit = 7; byte++ } }
  } else {
    for (let i = bl - 1; i >= 0; i--) if (sb + i <= 63) out.push(sb + i)
  }
  return out
}

/** Raw integer of the signal in 8 data bytes. */
export function decodeRaw(bytes, startBit, bitLength, byteOrder, signed) {
  const bl = Math.trunc(Number(bitLength) || 0)
  if (bl < 1 || bl > 32) return 0
  const bitAt = (p) => (((bytes[p >> 3] ?? 0) >> (p & 7)) & 1)
  let v = 0n
  if (Number(byteOrder) === 1) {
    let byte = Math.trunc(Number(startBit) || 0) >> 3, bit = Math.trunc(Number(startBit) || 0) & 7
    for (let i = 0; i < bl; i++) { if (byte <= 7 && bitAt(byte * 8 + bit)) v |= 1n << BigInt(bl - 1 - i); if (--bit < 0) { bit = 7; byte++ } }
  } else {
    const sb = Math.trunc(Number(startBit) || 0)
    for (let i = 0; i < bl; i++) if (sb + i <= 63 && bitAt(sb + i)) v |= 1n << BigInt(i)
  }
  if (signed && v & (1n << BigInt(bl - 1))) v -= 1n << BigInt(bl)
  return Number(BigInt.asIntN(32, v))   // (int32_t) as in the firmware: a 32-bit unsigned value above 2^31 reads negative
}

/** Raw and scaled value: { raw, value }. */
export function decode(bytes, s) {
  const raw = decodeRaw(bytes, s.startBit, s.bitLength, s.byteOrder, !!s.signed)
  const F = Math.fround
  return { raw, value: F(F(F(raw) * F(Number(s.factor) || 0)) + F(Number(s.offset) || 0)) }
}

/** The input's on/off rule (firmware CanInput::Compare): operator 0..7 against operand. */
export function compare(v, operator, operand) {
  const o = Math.fround(Number(operand) || 0)   // fOperand is a float on the module
  switch (Number(operator)) {
    case 0: return v === o
    case 1: return v !== o
    case 2: return v > o
    case 3: return v < o
    case 4: return v >= o
    case 5: return v <= o
    case 6: return ((v >>> 0) & (o >>> 0)) > 0
    case 7: return !(((v >>> 0) & (o >>> 0)) > 0)
  }
  return false
}

/** "0A ff 3" → [10, 255, 3, 0, 0, 0, 0, 0]; a byte that is not hex reads NaN. */
export function parseBytes(text) {
  const b = String(text ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8).map((x) => (/^[0-9a-f]{1,2}$/i.test(x) ? parseInt(x, 16) : NaN))
  while (b.length < 8) b.push(0)
  return b
}
