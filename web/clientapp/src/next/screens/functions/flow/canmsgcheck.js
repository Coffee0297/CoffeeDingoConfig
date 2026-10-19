// CAN message rolling counter + checksum (upstream dingoFW feat/can-msg-counter-checksum, 0x1D00+i subs 15-17).
import { has, isUpstream } from '../../hardware/parts/util.js'

// firmware CanOutputKind; 1 ("rolling counter") acts as none on a CAN message, so it is not offered
export const MSG_CHECKSUMS = [[0, 'None'], [2, 'XOR'], [3, 'Sum (mod 256)'], [4, 'CRC8 SAE J1850'], [5, 'CRC8 AUTOSAR']]
export const NO_COUNTER = 0xff

/** Fork firmware never has subs 15-17; upstream by its param list. */
export const hasMsgChecksum = (dev, n) => isUpstream(dev) && has(dev, 0x1d00 + n - 1, 15)

/** What the firmware will quietly do differently from what the user set (it ignores a byte at or past the length,
 *  and on a shared byte the checksum, computed last, overwrites the counter). */
export function msgChecksumWarnings({ dlc = 8, checksum = 0, checksumByte = 7, counterByte = NO_COUNTER } = {}) {
  const w = [], sum = checksum >= 2, cnt = counterByte !== NO_COUNTER
  if (sum && checksumByte >= dlc) w.push(`The checksum byte ${checksumByte} is past the length (${dlc} bytes): it is not sent.`)
  if (cnt && counterByte >= dlc) w.push(`The counter byte ${counterByte} is past the length (${dlc} bytes): it is not sent.`)
  if (sum && cnt && counterByte === checksumByte) w.push(`The counter and the checksum are both in byte ${checksumByte}: the checksum overwrites the counter.`)
  return w
}

/** Sentence tail: ", with a rolling counter in byte 6 and a CRC8 SAE J1850 checksum in byte 7" (or ''). */
export function msgChecksumWords({ checksum = 0, checksumByte = 7, counterByte = NO_COUNTER } = {}) {
  const p = []
  if (counterByte !== NO_COUNTER) p.push(`a rolling counter in byte ${counterByte}`)
  if (checksum >= 2) p.push(`a${checksum === 2 ? 'n' : ''} ${MSG_CHECKSUMS.find(([v]) => v === checksum)?.[1]} checksum in byte ${checksumByte}`)
  return p.length ? 'with ' + p.join(' and ') : ''
}
