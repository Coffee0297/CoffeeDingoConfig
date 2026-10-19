// CAN output kind (upstream dingoFW feat/can-output-counter-checksum, 0x2000 sub 11).
import { has, isUpstream } from '../../hardware/parts/util.js'

export const COUT_KINDS = ['Signal', 'Rolling counter', 'Checksum XOR', 'Checksum sum', 'CRC8 SAE J1850', 'CRC8 AUTOSAR']

/** Does the module take a kind? Fork firmware never has sub 11; upstream by its param list. */
export const hasCoutKind = (dev) => isUpstream(dev) && has(dev, 0x2000, 11)

/** A checksum must be one whole byte: 8 bits, start bit %8 == 0 (Intel) or == 7 (Motorola).
 *  The firmware drops a misaligned one, so the frame would go out without it (or not at all). */
export function coutKindProblem({ kind = 0, startBit = 0, bitLength = 0, byteOrder = 0 } = {}) {
  if (kind < 2) return ''
  if (bitLength !== 8) return 'A checksum is 8 bits long.'
  const want = byteOrder === 1 ? 7 : 0
  if (startBit % 8 !== want) return `A checksum fills one whole byte: start bit ${byteOrder === 1 ? '7, 15, 23 … (big endian)' : '0, 8, 16 … (little endian)'}.`
  return ''
}

/** Snap a draft to a valid checksum position (the byte its start bit is in). */
export function snapChecksum(d) {
  if ((d.kind ?? 0) < 2) return d
  return { ...d, bitLength: 8, startBit: Math.floor((d.startBit ?? 0) / 8) * 8 + (d.byteOrder === 1 ? 7 : 0) }
}

/** Other checksums on the same frame (each covers the bytes before it in output order). */
export const otherChecksums = (rows, me) => rows.filter((r) => r !== me && r.enabled && (r.kind ?? 0) >= 2 && r.id === me.id && !!r.ide === !!me.ide)
