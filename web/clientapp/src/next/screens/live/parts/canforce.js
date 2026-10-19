// Force a CAN input from the app: build the payload its source frame must carry so the module decodes `value`.
// Mirrors the firmware decoder (CoffeeDingoFW utils/dbc.cpp DecodeLE / DecodeBE, CanInput::CheckMsg):
// value = raw * factor + offset, raw read as int32. Intel: LSB at startBit over the 8 bytes as one 64-bit word.
// Motorola: MSB at startBit, each next bit one lower in the byte, wrapping to bit 7 of the next byte.

/** The raw range the module can decode for this input: [min, max]. Unsigned stops at 2^31-1 (decoded as int32). */
export function rawRange(inp) {
  const n = inp.bitLength
  return inp.signed ? [-(2 ** (n - 1)), 2 ** (n - 1) - 1] : [0, Math.min(2 ** n - 1, 2 ** 31 - 1)]
}

/** Physical value -> clamped raw integer. */
export function toRaw(inp, value) {
  const f = Number(inp.factor) || 1
  const [lo, hi] = rawRange(inp)
  return Math.min(hi, Math.max(lo, Math.round((Number(value) - (Number(inp.offset) || 0)) / f)))
}

/** The physical value the module will read for a raw integer (what is really forced after rounding/clamping). */
export const fromRaw = (inp, raw) => raw * (Number(inp.factor) || 1) + (Number(inp.offset) || 0)

/** Bit positions (byte, bit) the field covers, MSB of the raw value first. Throws when it runs out of the 8 bytes. */
function bits(inp) {
  const n = inp.bitLength, s = inp.startBit, out = []
  if (!(n >= 1 && n <= 32) || !(s >= 0 && s <= 63)) throw new Error('This CAN input has no valid start bit and length.')
  if (Number(inp.byteOrder) === 1) {
    let byte = s >> 3, bit = s & 7
    for (let i = 0; i < n; i++) { out.push([byte, bit]); if (--bit < 0) { bit = 7; byte++ } }
  } else for (let i = n - 1; i >= 0; i--) out.push([(s + i) >> 3, (s + i) & 7])
  if (out.some(([b]) => b > 7)) throw new Error('This CAN input reads past the 8th byte of the frame.')
  return out
}

/**
 * The 8 data bytes that make the module read `value` for input `inp` ({startBit, bitLength, byteOrder, factor,
 * offset, signed}). `base` = the frame as last seen on the bus (other signals in it keep their bits), else zeros.
 */
export function encodeForce(inp, value, base = []) {
  const data = Array.from({ length: 8 }, (_, i) => (base[i] ?? 0) & 0xff)
  const u = toRaw(inp, value) >>> 0   // two's complement for a negative raw
  const pos = bits(inp)
  pos.forEach(([byte, bit], i) => {
    const v = (u >>> (pos.length - 1 - i)) & 1
    data[byte] = v ? data[byte] | (1 << bit) : data[byte] & ~(1 << bit)
  })
  return data
}

/** "0A 1B ..." from /api/canlog -> byte array. */
export const parseHex = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16) & 0xff)
export const toHex = (data) => data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')
