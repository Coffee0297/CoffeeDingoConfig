// node src/next/screens/functions/flow/canmsgcheck.test.js — CAN message counter / checksum (upstream dingoFW
// feat/can-msg-counter-checksum, 0x1D00+i subs 15-17): gating, the firmware's silent cases, sentence.
import assert from 'node:assert/strict'
import { hasMsgChecksum, msgChecksumWarnings, msgChecksumWords, MSG_CHECKSUMS } from './canmsgcheck.js'
import { buildModel } from './model.js'
import { sentenceFor } from './sentence.js'

assert.ok(!MSG_CHECKSUMS.some(([v]) => v === 1), 'kind 1 acts as none: not offered')
const up = (subs) => ({ type: 'dingoPDM', family: 'upstream', paramRuns: [[0x1d00, 4, ...subs]] })
assert.ok(hasMsgChecksum(up([...Array(18).keys()]), 1))
assert.ok(!hasMsgChecksum(up([...Array(15).keys()]), 1), 'stock can-message-block firmware')
assert.ok(!hasMsgChecksum({ type: 'dingoPDM', version: 'v5.6.6' }, 1), 'fork')

assert.deepEqual(msgChecksumWarnings({ dlc: 8, checksum: 4, checksumByte: 7, counterByte: 6 }), [])
assert.deepEqual(msgChecksumWarnings({ dlc: 8, checksum: 0, checksumByte: 7, counterByte: 0xff }), [])
assert.equal(msgChecksumWarnings({ dlc: 4, checksum: 2, checksumByte: 5, counterByte: 6 }).length, 2)   // both past DLC 4
assert.match(msgChecksumWarnings({ dlc: 8, checksum: 3, checksumByte: 3, counterByte: 3 })[0], /checksum overwrites the counter/)
assert.deepEqual(msgChecksumWarnings({ dlc: 2, checksum: 0, checksumByte: 7, counterByte: 0xff }), [], 'no checksum: its byte does not matter')

assert.equal(msgChecksumWords({ checksum: 4, checksumByte: 7, counterByte: 6 }), 'with a rolling counter in byte 6 and a CRC8 SAE J1850 checksum in byte 7')
assert.equal(msgChecksumWords({ checksum: 2, checksumByte: 0, counterByte: 0xff }), 'with an XOR checksum in byte 0')
assert.equal(msgChecksumWords({ checksum: 0, counterByte: 0xff }), '')

const vmap = [{ index: 10, name: 'go', kind: 'caninput', number: 1, prop: 'State', type: 'bool' }]
const m = buildModel(up([...Array(18).keys()]), { canInputs: [{ number: 1, name: 'go', enabled: true, id: 0x100, bitLength: 8 }],
  canMessages: [{ number: 1, name: 'cmd', enabled: true, input: 10, id: 0x321, dlc: 8, data: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xa0, 0], mode: 0, intervalMs: 100, checksum: 4, checksumByte: 7, counterByte: 6 }] }, vmap)
const words = sentenceFor(m, m.nodes.get('canmsg:1')).map((s) => s.t ?? s.label).join(' ')
assert.match(words, /every 100 ms , with a rolling counter in byte 6 and a CRC8 SAE J1850 checksum in byte 7 \.$/)
console.log('canmsgcheck.test.js ok')
