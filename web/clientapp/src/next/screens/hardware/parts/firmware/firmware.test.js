// node src/next/screens/hardware/parts/firmware/firmware.test.js — flash path and file kinds (upstream .hex over CAN)
import assert from 'node:assert/strict'
import { flashPath, fitsPath, extFor, checkFile, fileVersion, isFull, boardOfFile, BOARDS } from './firmwareLogic.js'

const fork = { name: 'PDM-01', type: 'dingoPDM', canBootloader: true }
const upNo = { name: 'PDM-02', type: 'dingoPDM', family: 'upstream', canBootloader: false }
const upYes = { ...upNo, canBootloader: true }
const cbUp = { name: 'CB-1', type: 'CANBoard', family: 'upstream', canBootloader: false }
assert.equal(flashPath(fork, true), 'can')
assert.equal(flashPath(upNo, true), 'usb')     // not known to have the bootloader: never a CAN update
assert.equal(flashPath(upYes, true), 'can')
assert.equal(flashPath(cbUp, true), null)      // no upstream CANBoard port of the bootloader
assert.equal(fitsPath('dingopdm_v7_FW_v0-6-1.hex', 'can'), true)
assert.equal(fitsPath('dingopdm_v7_FW_v5-6-6.srec', 'can'), true)
assert.equal(fitsPath('dingopdm_v7_FW_v0-6-1.bin', 'can'), false)
assert.equal(fitsPath('dingopdm_v7_FW_v0-6-1.hex', 'usb'), false)
assert.equal(extFor('can'), '.srec or .hex')
assert.equal(checkFile(upYes, { name: 'dingopdm_v7_FW_v0-6-1.hex' }, 'can').ok, true)
assert.equal(checkFile(upYes, { name: 'dingopdmmax_v1_FW_v0-6-1.hex' }, 'can').ok, false)
assert.equal(fileVersion('dingopdm_v7_FW_v0-6-1.hex'), '0.6.1')
console.log('firmware.test.js ok')

// _FULL_ release images (bootloader + app): told apart from the app images, same board, same version
assert.ok(isFull('dingopdm_v7_FULL_v5-7-1.bin'))
assert.ok(!isFull('dingopdm_v7_FW_v5-7-1.bin'))
assert.equal(boardOfFile('canboard_v2_FULL_v5-7-1.hex'), BOARDS.canboard)
assert.equal(fileVersion('dingopdmmax_v1_FULL_v5-7-1.hex'), '5.7.1')
